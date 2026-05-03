const axios = require('axios');

// ========================
// 🔐 CONFIGURAÇÕES MEMED (VIA ENV)
// ========================
const MEMED_API_URL = process.env.MEMED_API_URL || 'https://integrations.api.memed.com.br/v1';
const API_KEY = process.env.MEMED_API_KEY;
const SECRET_KEY = process.env.MEMED_SECRET_KEY;

// DADOS DO PRESCRITOR (via ENV para segurança)
const PRESCRITOR_DATA = {
  data: {
    type: "usuarios",
    attributes: {
      external_id: process.env.MEMED_PRESCRITOR_EXTERNAL_ID || "dr_max_vinicius_001",
      nome: process.env.MEMED_PRESCRITOR_NOME || "Max",
      sobrenome: process.env.MEMED_PRESCRITOR_SOBRENOME || "Vinicius Ferreira Matos",
      cpf: process.env.MEMED_PRESCRITOR_CPF || "01739134150",
      board: {
        board_code: process.env.MEMED_PRESCRITOR_BOARD_CODE || "CRM",
        board_number: process.env.MEMED_PRESCRITOR_BOARD_NUMBER || "163032",
        board_state: process.env.MEMED_PRESCRITOR_BOARD_STATE || "SP"
      },
      email: process.env.MEMED_PRESCRITOR_EMAIL || "dr.max.vinicius.cg@outlook.com",
      telefone: process.env.MEMED_PRESCRITOR_TELEFONE || "11968123900",
      sexo: process.env.MEMED_PRESCRITOR_SEXO || "M",
      data_nascimento: process.env.MEMED_PRESCRITOR_DATA_NASC || "09/02/1988"
    },
    relationships: {
      cidade: {
        data: {
          type: "cidades",
          id: parseInt(process.env.MEMED_CIDADE_ID) || 5273
        }
      },
      especialidade: {
        data: {
          type: "especialidades",
          id: parseInt(process.env.MEMED_ESPECIALIDADE_ID) || 45
        }
      }
    }
  }
};

// Cache do token em memória (evita chamadas repetidas)
let tokenCache = {
  token: null,
  expiresAt: null
};

// ========================
// 🔐 CADASTRAR E OBTER TOKEN
// ========================
async function gerarTokenPrescritor(forceRefresh = false) {
  // Verificar cache
  if (!forceRefresh && tokenCache.token && tokenCache.expiresAt > Date.now()) {
    console.log('✅ Usando token em cache');
    return tokenCache.token;
  }

  // Validar credenciais
  if (!API_KEY || !SECRET_KEY) {
    console.error('❌ MEMED_API_KEY ou MEMED_SECRET_KEY não configuradas nas variáveis de ambiente');
    return null;
  }

  try {
    console.log('🔐 Autenticando prescritor na Memed...');
    
    // Primeiro, tentar obter token do prescritor existente
    try {
      const getResponse = await axios.get(
        `${MEMED_API_URL}/sinapse-prescricao/usuarios/${PRESCRITOR_DATA.data.attributes.external_id}?api-key=${API_KEY}&secret-key=${SECRET_KEY}`,
        {
          headers: {
            'Accept': 'application/vnd.api+json',
            'Content-Type': 'application/json',
            'User-Agent': 'DoctorPrescreve/1.0'
          },
          timeout: 30000
        }
      );
      
      if (getResponse.data?.data?.attributes?.token) {
        const token = getResponse.data.data.attributes.token;
        tokenCache = {
          token: token,
          expiresAt: Date.now() + 55 * 60 * 1000
        };
        console.log('✅ Token obtido (prescritor existente)!');
        return token;
      }
    } catch (getError) {
      if (getError.response?.status !== 404) {
        throw getError;
      }
      // Prescritor não existe, vamos criar
    }
    
    console.log('📝 Prescritor não encontrado, criando novo...');
    
    const response = await axios.post(
      `${MEMED_API_URL}/sinapse-prescricao/usuarios?api-key=${API_KEY}&secret-key=${SECRET_KEY}`,
      PRESCRITOR_DATA,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.api+json',
          'User-Agent': 'DoctorPrescreve/1.0'
        },
        timeout: 30000,
        validateStatus: () => true // Aceitar qualquer status para tratamento customizado
      }
    );
    
    // Tratar resposta 422 (já existe)
    if (response.status === 422) {
      console.log('⚠️ Prescritor já existe, buscando por external_id...');
      const getResponse = await axios.get(
        `${MEMED_API_URL}/sinapse-prescricao/usuarios/${PRESCRITOR_DATA.data.attributes.external_id}?api-key=${API_KEY}&secret-key=${SECRET_KEY}`,
        {
          headers: {
            'Accept': 'application/vnd.api+json',
            'User-Agent': 'DoctorPrescreve/1.0'
          },
          timeout: 30000
        }
      );
      
      if (getResponse.data?.data?.attributes?.token) {
        const token = getResponse.data.data.attributes.token;
        tokenCache = {
          token: token,
          expiresAt: Date.now() + 55 * 60 * 1000
        };
        console.log('✅ Token obtido (prescritor existente)!');
        return token;
      }
    }
    
    const token = response.data?.data?.attributes?.token;
    
    if (token) {
      // Token válido por 1 hora (padrão Memed)
      tokenCache = {
        token: token,
        expiresAt: Date.now() + 55 * 60 * 1000 // 55 minutos
      };
      console.log('✅ Token obtido e armazenado em cache!');
      return token;
    }
    
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`API retornou status ${response.status}: ${JSON.stringify(response.data)}`);
    }
    
    console.log('⚠️ Token não encontrado na resposta');
    return null;
    
  } catch (error) {
    console.error('❌ Erro ao autenticar prescritor:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Mensagem: ${JSON.stringify(error.response.data)}`);
    } else if (error.code === 'ECONNABORTED') {
      console.error(`   Timeout: A conexão com a API Memed demorou muito`);
    } else {
      console.error(`   Mensagem: ${error.message}`);
    }
    
    return null;
  }
}

// ========================
// 📝 NOTA SOBRE EMISSÃO
// ========================
// A emissão de receitas NÃO deve ser feita via Backend para garantir compliance e assinatura digital.
// O fluxo correto é:
// 1. Backend gera o token do prescritor.
// 2. Frontend carrega o MdHub com o token.
// 3. Médico finaliza a prescrição na interface da Memed.
// 4. Frontend captura o evento de finalização e notifica o backend.

// ========================
// 🔄 FORÇAR RENOVAÇÃO DO TOKEN
// ========================
async function renovarToken() {
  console.log('🔄 Forçando renovação do token Memed...');
  tokenCache.token = null;
  tokenCache.expiresAt = null;
  return await gerarTokenPrescritor(true);
}

// ========================
// 🧪 TESTE DE CONEXÃO
// ========================
async function testarConexao() {
  console.log('🧪 Testando conexão com Memed API...');
  
  if (!API_KEY || !SECRET_KEY) {
    console.error('❌ Variáveis MEMED_API_KEY e/ou MEMED_SECRET_KEY não configuradas');
    return false;
  }
  
  const token = await gerarTokenPrescritor(true);
  const sucesso = !!token;
  
  if (sucesso) {
    console.log('✅ Conexão com Memed OK! Token válido.');
  } else {
    console.log('❌ Conexão com Memed falhou - verifique as credenciais');
  }
  
  return sucesso;
}

// ========================
// 📋 VERIFICAR STATUS DA CONTA
// ========================
async function verificarStatusConta() {
  const token = await gerarTokenPrescritor();
  
  if (!token) {
    return {
      status: 'error',
      mensagem: 'Não foi possível autenticar na Memed'
    };
  }
  
  return {
    status: 'ok',
    mensagem: 'Conta Memed configurada corretamente',
    prescritor: {
      nome: PRESCRITOR_DATA.data.attributes.nome,
      sobrenome: PRESCRITOR_DATA.data.attributes.sobrenome,
      cpf: PRESCRITOR_DATA.data.attributes.cpf,
      crm: `${PRESCRITOR_DATA.data.attributes.board.board_code} ${PRESCRITOR_DATA.data.attributes.board.board_number}`
    }
  };
}

// ========================
// 📤 OBTER TOKEN PARA FRONTEND
// ========================
async function obterTokenParaFrontend() {
  const token = await gerarTokenPrescritor();
  if (!token) {
    throw new Error('Não foi possível obter token para o frontend');
  }
  return token;
}

module.exports = {
  gerarTokenPrescritor,
  testarConexao,
  renovarToken,
  verificarStatusConta,
  obterTokenParaFrontend
};
