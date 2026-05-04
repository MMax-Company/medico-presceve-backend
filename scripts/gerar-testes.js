require('dotenv').config();
const db = require('../db');

async function gerarTestes() {
  try {
    await db.initDB();
    console.log('✅ Conectado ao banco para gerar testes...');

    const testes = [
      {
        nome: 'João Silva (Teste Elegível)',
        cpf: '12345678901',
        telefone: '5511999999999',
        data_nasc: '1985-05-20',
        medicamento: 'Losartana 50mg',
        tempo_uso: '2 anos',
        data_ultima_receita: '2024-01-10',
        status: 'FILA'
      },
      {
        nome: 'Maria Oliveira (Teste Alerta)',
        cpf: '98765432100',
        telefone: '5511988888888',
        data_nasc: '1970-10-15',
        medicamento: 'Metformina 850mg',
        tempo_uso: '5 anos',
        data_ultima_receita: '2023-05-20',
        status: 'FILA'
      },
      {
        nome: 'Carlos Santos (Aguardando Pagamento)',
        cpf: '11122233344',
        telefone: '5511977777777',
        data_nasc: '1990-02-28',
        medicamento: 'Sertralina 50mg',
        tempo_uso: '1 ano',
        data_ultima_receita: '2024-02-15',
        status: 'AGUARDANDO_PAGAMENTO'
      }
    ];

    for (const t of testes) {
      await db.adicionarAtendimento(t);
      console.log(`➕ Gerado: ${t.nome}`);
    }

    console.log('\n🚀 Todos os testes foram injetados com sucesso!');
    console.log('👉 Atualize seu painel no navegador para ver os novos atendimentos.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Erro ao gerar testes:', e.message);
    process.exit(1);
  }
}

gerarTestes();
