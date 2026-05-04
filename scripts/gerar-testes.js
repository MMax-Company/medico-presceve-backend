require('dotenv').config();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

async function gerarTestes() {
  try {
    // A função initDB já é chamada dentro das outras funções no db.js
    console.log('✅ Conectado ao banco para gerar testes...');

    const testes = [
      {
        id: uuidv4(),
        paciente: {
          nome: 'João Silva (Teste Elegível)',
          cpf: '12345678901',
          telefone: '5511999999999',
          email: 'joao@teste.com',
          data_nascimento: '1985-05-20'
        },
        triagem: { 
          pressao: '12/8', 
          diabetes: 'Não', 
          medicamento: 'Losartana 50mg',
          tempo_uso: '2 anos',
          data_ultima_receita: '2024-01-10'
        },
        dados_clinicos: { historico: 'Paciente estável' },
        elegivel: true,
        motivo: 'Renovação padrão',
        status: 'FILA',
        pagamento: true,
        criadoEm: new Date().toISOString()
      },
      {
        id: uuidv4(),
        paciente: {
          nome: 'Maria Oliveira (Teste Alerta)',
          cpf: '98765432100',
          telefone: '5511988888888',
          email: 'maria@teste.com',
          data_nascimento: '1970-10-15'
        },
        triagem: { 
          pressao: '15/9', 
          diabetes: 'Sim', 
          medicamento: 'Metformina 850mg',
          tempo_uso: '5 anos',
          data_ultima_receita: '2023-05-20'
        },
        dados_clinicos: { historico: 'Receita antiga' },
        elegivel: true,
        motivo: 'Necessita atenção na triagem',
        status: 'FILA',
        pagamento: true,
        criadoEm: new Date().toISOString()
      },
      {
        id: uuidv4(),
        paciente: {
          nome: 'Carlos Santos (Aguardando Pagamento)',
          cpf: '11122233344',
          telefone: '5511977777777',
          email: 'carlos@teste.com',
          data_nascimento: '1990-02-28'
        },
        triagem: { 
          pressao: '12/8', 
          diabetes: 'Não', 
          medicamento: 'Sertralina 50mg',
          tempo_uso: '1 ano',
          data_ultima_receita: '2024-02-15'
        },
        dados_clinicos: { historico: 'Primeiro atendimento' },
        elegivel: true,
        motivo: 'Aguardando checkout',
        status: 'AGUARDANDO_PAGAMENTO',
        pagamento: false,
        criadoEm: new Date().toISOString()
      },
      {
        id: uuidv4(),
        paciente: {
          nome: 'Ana Souza (Recusada - Pressão Alta)',
          cpf: '55566677788',
          telefone: '5511966666666',
          email: 'ana@teste.com',
          data_nascimento: '1975-03-12'
        },
        triagem: { 
          pressao: '18/11', 
          diabetes: 'Não', 
          medicamento: 'Atenolol 25mg',
          tempo_uso: '3 anos',
          data_ultima_receita: '2024-03-01'
        },
        dados_clinicos: { historico: 'Hipertensão descontrolada' },
        elegivel: false,
        motivo: 'Sinais de alerta graves na triagem',
        status: 'RECUSADO',
        pagamento: true,
        criadoEm: new Date().toISOString()
      }
    ];

    for (const t of testes) {
      const sucesso = await db.salvarAtendimento(t);
      if (sucesso) {
        console.log(`➕ Gerado: ${t.paciente.nome}`);
      } else {
        console.log(`❌ Erro ao gerar: ${t.paciente.nome}`);
      }
    }

    console.log('\n🚀 Todos os testes foram processados!');
    console.log('👉 Atualize seu painel no navegador para ver os novos atendimentos.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Erro ao gerar testes:', e.message);
    process.exit(1);
  }
}

gerarTestes();
