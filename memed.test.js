
require('dotenv').config();
const memed = require('./memed');

async function runTest() {
  console.log('🚀 Iniciando Teste de Integração Memed...');
  console.log('-----------------------------------------');

  // 1. Verificar Variáveis de Ambiente
  console.log('1. Verificando Variáveis de Ambiente...');
  const keys = {
    API_KEY: process.env.MEMED_API_KEY ? '✅ Configurada' : '❌ Faltando',
    SECRET_KEY: process.env.MEMED_SECRET_KEY ? '✅ Configurada' : '❌ Faltando',
    MEDICO_CPF: process.env.MEMED_PRESCRITOR_CPF ? '✅ Configurado' : '❌ Faltando'
  };
  console.table(keys);

  if (!process.env.MEMED_API_KEY || !process.env.MEMED_SECRET_KEY) {
    console.error('🛑 Erro: Chaves da API não encontradas no .env');
    process.exit(1);
  }

  // 2. Testar Conexão e Token
  console.log('\n2. Testando Conexão e Geração de Token...');
  try {
    const token = await memed.gerarTokenPrescritor(true);
    if (token) {
      console.log('✅ Sucesso! Token gerado:', token.substring(0, 15) + '...');
    } else {
      console.error('❌ Falha ao gerar token. Verifique as credenciais e o CPF do médico.');
    }
  } catch (error) {
    console.error('❌ Erro durante a geração do token:', error.message);
  }

  // 3. Verificar Status da Conta
  console.log('\n3. Verificando Status da Conta na Memed...');
  try {
    const status = await memed.verificarStatusConta();
    if (status.status === 'ok') {
      console.log('✅ Conta Ativa!');
      console.log(`👨‍⚕️ Médico: ${status.prescritor.nome} ${status.prescritor.sobrenome}`);
      console.log(`🆔 CRM: ${status.prescritor.crm}`);
    } else {
      console.error('❌ Erro no status da conta:', status.mensagem);
    }
  } catch (error) {
    console.error('❌ Erro ao verificar status:', error.message);
  }

  console.log('\n-----------------------------------------');
  console.log('🏁 Teste Finalizado.');
}

runTest();
