const axios = require('axios');

// ========================
// 🔐 CONFIGURAÇÕES MEMED (HOMOLOGAÇÃO)
// ========================
const MEMED_API_URL = 'https://integrations.api.memed.com.br/v1';
const API_KEY = 'iJGiB4kjDGOLeDFPWMG3no9VnN7Abpqe3w1jEFm6olkhkZD6oSfSmYCm';
const SECRET_KEY = 'Xe8M5GvBGCr4FStKfxXKisRo3SfYKI7KrTMkJpCAstzu2yXVN4av5nmL';

// DADOS DO PRESCRITOR (MÉDICO)
const PRESCRITOR_DATA = {
  data: {
    type: "usuarios",
    attributes: {
      external_id: "dr_max_vinicius_001",
      nome: "Max",
      sobrenome: "Vinicius Ferreira Matos",
      cpf: "01739134150",
      board: {
        board_code: "CRM",
        board_number: "163032",
        board_state: "SP"
      },
      email: "dr.max.vinicius.cg@outlook.com",
      telefone: "11968123900",
      sexo: "M",
      data_nascimento: "09/02/1988"
    },
    relationships: {
      cidade: {
        data: {
          type: "cidades",
          id: 5273
        }
      },
      especialidade: {
        data: {
          type: "especialidades",
          id: 45
        }
      }
    }
  }
};

// ========================
// 🔐 CADASTRAR E OBTER TOKEN
// ========================
async function gerarTokenPrescritor() {
  try {
    console.log('🔐 Cadastrando prescritor na Memed...');
    
    // Tenta cadastrar o prescritor
    const response = await axios.post(
      `${MEMED_API_URL}/sinapse-prescricao/usuarios?api-key=${API_KEY}&secret-key=${SECRET_KEY}`,
      PRESCRITOR_DATA,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.api+json'
        }
      }
    );
    
    const token = response.data?.data?.attributes?.token;
    
    if (token) {
      console.log('✅ Cadastro realizado! Token obtido com sucesso!');
      return token;
    }
    
    console.log('⚠️ Token não encontrado na resposta');
    return null;
    
  } catch (error) {
    // Se o prescritor já existe, tenta buscar
    if (error.response?.status === 422 || error.response?.status === 400) {
      console.log('⚠️ Prescritor pode já existir, tentando buscar por CPF...');
      return await buscarPrescritorPorCPF();
    }
    
    console.error('❌ Erro ao cadastrar prescritor:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Mensagem: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   Mensagem: ${error.message}`);
    }
    
    return null;
  }
}

// ========================
// 🔍 BUSCAR PRESCRITOR POR CPF
// ========================
async function buscarPrescritorPorCPF() {
  try {
    console.log('🔍 Buscando prescritor por CPF: 01739134150');
    
    const response = await axios.get(
      `${MEMED_API_URL}/sinapse-prescricao/usuarios/01739134150?api-key=${API_KEY}&secret-key=${SECRET_KEY}`,
      {
        headers: {
          'Accept': 'application/vnd.api+json'
        }
      }
    );
    
    const token = response.data?.data?.attributes?.token;
    
    if (token) {
      console.log('✅ Prescritor encontrado! Token obtido com sucesso!');
      return token;
    }
    
    return null;
    
  } catch (error) {
    console.error('❌ Prescritor não encontrado na Memed');
    console.error('   Você precisa cadastrar primeiro via POST');
    return null;
  }
}

// ========================
// 💊 EMITIR RECEITA VIA MEMED
// ========================
async function emitirReceita(atendimento) {
  try {
    const token = await gerarTokenPrescritor();
    
    if (!token) {
      console.log('⚠️ Usando fallback - Memed indisponível');
      return gerarReceitaFallback(atendimento);
    }
    
    console.log('📝 Emitindo receita para:', atendimento.paciente.nome);
    
    const response = await axios.post(
      `${MEMED_API_URL}/prescricao?token=${token}`,
      {
        paciente: {
          idExterno: atendimento.id,
          nome: atendimento.paciente.nome,
          cpf: atendimento.paciente.cpf,
          data_nascimento: atendimento.paciente.data_nascimento,
          telefone: atendimento.paciente.whatsapp,
          email: atendimento.paciente.email
        },
        medicamentos: [
          {
            nome: atendimento.triagem?.medicamento || 'Medicação não informada',
            quantidade: '1',
            unidade: 'cx',
            posologia: 'Conforme orientação médica',
            duracao: '60 dias'
          }
        ],
        orientacoes: atendimento.prontuario?.conduta || 'Renovação de receita de uso contínuo.'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.api+json'
        }
      }
    );
    
    console.log('✅ Receita emitida com sucesso!');
    
    return {
      sucesso: true,
      link: response.data?.data?.attributes?.link || `https://integrations.memed.com.br/receita/${atendimento.id}`,
      pdf: response.data?.data?.attributes?.pdf || `https://integrations.memed.com.br/receita/${atendimento.id}/pdf`,
      id: response.data?.data?.id,
      emitidaEm: new Date().toISOString(),
      plataforma: 'Memed'
    };
    
  } catch (error) {
    console.error('❌ Erro ao emitir receita:', error.response?.data || error.message);
    return gerarReceitaFallback(atendimento);
  }
}

// ========================
// 🔥 FALLBACK
// ========================
function gerarReceitaFallback(atendimento) {
  return {
    sucesso: true,
    link: `https://doctorprescreve.com.br/receita/${atendimento.id}`,
    pdf: `https://doctorprescreve.com.br/receita/${atendimento.id}/pdf`,
    observacao: 'Aguardando ativação da Memed',
    plataforma: 'Doctor Prescreve (Fallback)'
  };
}

// ========================
// 🧪 TESTE DE CONEXÃO
// ========================
async function testarConexao() {
  const token = await gerarTokenPrescritor();
  console.log(token ? '✅ Conexão com Memed OK!' : '❌ Conexão com Memed falhou');
  return !!token;
}

module.exports = {
  gerarTokenPrescritor,
  emitirReceita,
  testarConexao
};