const { Pool } = require('pg');

let pool = null;

// ========================
// 🔌 INICIALIZAR CONEXÃO
// ========================
function initDB() {
  if (pool) return pool;
  
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL não encontrada. Adicione um banco PostgreSQL no Railway!');
    return null;
  }
  
  console.log('✅ Conectando ao PostgreSQL...');
  
  pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
  
  // Criar tabela se não existir
  pool.query(`
    CREATE TABLE IF NOT EXISTS atendimentos (
      id VARCHAR(36) PRIMARY KEY,
      paciente_nome TEXT,
      paciente_cpf TEXT,
      paciente_telefone TEXT,
      paciente_email TEXT,
      paciente_data_nasc TEXT,
      triagem JSONB,
      elegivel BOOLEAN,
      motivo TEXT,
      status VARCHAR(50),
      pagamento BOOLEAN DEFAULT false,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `).then(() => {
    console.log('✅ Tabela "atendimentos" criada/verificada com sucesso!');
  }).catch(err => {
    console.error('❌ Erro ao criar tabela:', err);
  });

  // Criar tabela de fila de suporte
  pool.query(`
    CREATE TABLE IF NOT EXISTS fila_suporte (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(20) NOT NULL,
      nome VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'aguardando',
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    )
  `).then(() => {
    console.log('✅ Tabela "fila_suporte" criada/verificada com sucesso!');
  }).catch(err => {
    console.error('❌ Erro ao criar tabela fila_suporte:', err);
  });
  
  return pool;
}

// ========================
// 📋 BUSCAR TODOS ATENDIMENTOS
// ========================
async function getAtendimentos() {
  const db = initDB();
  if (!db) return [];
  
  try {
    const result = await db.query(
      'SELECT * FROM atendimentos ORDER BY criado_em DESC'
    );
    return result.rows;
  } catch (err) {
    console.error('Erro ao buscar atendimentos:', err);
    return [];
  }
}

// ========================
// 💾 SALVAR ATENDIMENTO
// ========================
async function salvarAtendimento(atendimento) {
  const db = initDB();
  if (!db) return false;
  
  const query = `
    INSERT INTO atendimentos 
    (id, paciente_nome, paciente_cpf, paciente_telefone, paciente_email, 
     paciente_data_nasc, triagem, elegivel, motivo, status, pagamento, criado_em)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO UPDATE SET
      paciente_nome = EXCLUDED.paciente_nome,
      paciente_cpf = EXCLUDED.paciente_cpf,
      paciente_telefone = EXCLUDED.paciente_telefone,
      paciente_email = EXCLUDED.paciente_email,
      paciente_data_nasc = EXCLUDED.paciente_data_nasc,
      triagem = EXCLUDED.triagem,
      elegivel = EXCLUDED.elegivel,
      motivo = EXCLUDED.motivo,
      status = EXCLUDED.status,
      pagamento = EXCLUDED.pagamento
  `;
  
  try {
    await db.query(query, [
      atendimento.id,
      atendimento.paciente?.nome || null,
      atendimento.paciente?.cpf || null,
      atendimento.paciente?.telefone || null,
      atendimento.paciente?.email || null,
      atendimento.paciente?.data_nascimento || null,
      JSON.stringify(atendimento.triagem || {}),
      atendimento.elegivel,
      atendimento.motivo,
      atendimento.status,
      atendimento.pagamento || false,
      atendimento.criadoEm || new Date().toISOString()
    ]);
    return true;
  } catch (err) {
    console.error('Erro ao salvar atendimento:', err);
    return false;
  }
}

// ========================
// 🔍 BUSCAR ATENDIMENTO POR ID
// ========================
async function buscarAtendimentoPorId(id) {
  const db = initDB();
  if (!db) return null;
  
  try {
    const result = await db.query(
      'SELECT * FROM atendimentos WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Erro ao buscar atendimento:', err);
    return null;
  }
}

// ========================
// 💰 ATUALIZAR STATUS PAGAMENTO
// ========================
async function atualizarStatusPagamento(id, pagamento, status) {
  const db = initDB();
  if (!db) return false;
  
  try {
    await db.query(
      'UPDATE atendimentos SET pagamento = $1, status = $2 WHERE id = $3',
      [pagamento, status, id]
    );
    return true;
  } catch (err) {
    console.error('Erro ao atualizar pagamento:', err);
    return false;
  }
}

// ========================
// ✅ ATUALIZAR STATUS (APROVAR/RECUSAR)
// ========================
async function atualizarStatus(id, decisao) {
  const db = initDB();
  if (!db) return false;
  
  const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO';
  
  try {
    await db.query(
      'UPDATE atendimentos SET status = $1 WHERE id = $2',
      [novoStatus, id]
    );
    return true;
  } catch (err) {
    console.error('Erro ao atualizar status:', err);
    return false;
  }
}

// ========================
// 📊 ESTATÍSTICAS COMPLETAS
// ========================
async function getEstatisticas() {
  const db = initDB();
  if (!db) return { total: 0, elegiveis: 0, pagos: 0, naFila: 0, aprovados: 0, recusados: 0 };
  
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN elegivel = true THEN 1 ELSE 0 END) as elegiveis,
        SUM(CASE WHEN pagamento = true THEN 1 ELSE 0 END) as pagos,
        SUM(CASE WHEN pagamento = true AND status = 'FILA' THEN 1 ELSE 0 END) as na_fila,
        SUM(CASE WHEN status = 'APROVADO' THEN 1 ELSE 0 END) as aprovados,
        SUM(CASE WHEN status = 'RECUSADO' THEN 1 ELSE 0 END) as recusados
      FROM atendimentos
    `);
    
    return {
      total: parseInt(result.rows[0].total) || 0,
      elegiveis: parseInt(result.rows[0].elegiveis) || 0,
      pagos: parseInt(result.rows[0].pagos) || 0,
      naFila: parseInt(result.rows[0].na_fila) || 0,
      aprovados: parseInt(result.rows[0].aprovados) || 0,
      recusados: parseInt(result.rows[0].recusados) || 0
    };
  } catch (err) {
    console.error('Erro ao buscar estatísticas:', err);
    return { total: 0, elegiveis: 0, pagos: 0, naFila: 0, aprovados: 0, recusados: 0 };
  }
}

// ========================
// 📋 BUSCAR ATENDIMENTOS POR STATUS
// ========================
async function getAtendimentosPorStatus(status) {
  const db = initDB();
  if (!db) return [];
  
  try {
    const result = await db.query(
      'SELECT * FROM atendimentos WHERE status = $1 ORDER BY criado_em DESC',
      [status]
    );
    return result.rows;
  } catch (err) {
    console.error('Erro ao buscar atendimentos por status:', err);
    return [];
  }
}

// ========================
// 🗑️ DELETAR ATENDIMENTO
// ========================
async function deletarAtendimento(id) {
  const db = initDB();
  if (!db) return false;
  
  try {
    await db.query('DELETE FROM atendimentos WHERE id = $1', [id]);
    console.log(`🗑️ Atendimento ${id} deletado`);
    return true;
  } catch (err) {
    console.error('Erro ao deletar atendimento:', err);
    return false;
  }
}

// ========================
// 🗑️ DELETAR ATENDIMENTOS ANTIGOS
// ========================
async function deletarAtendimentosAntigos(dias) {
  const db = initDB();
  if (!db) return false;
  
  try {
    await db.query(
      'DELETE FROM atendimentos WHERE criado_em < NOW() - INTERVAL \'$1 days\'',
      [dias]
    );
    return true;
  } catch (err) {
    console.error('Erro ao deletar atendimentos antigos:', err);
    return false;
  }
}

// ========================
// 🏥 HEALTH CHECK DO BANCO
// ========================
async function healthCheck() {
  const db = initDB();
  if (!db) return false;
  
  try {
    await db.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('Erro no health check do banco:', err);
    return false;
  }
}

// ========================
// 🔄 FECHAR CONEXÃO (UTILITÁRIO)
// ========================
async function closeConnection() {
  if (!pool) return;
  
  try {
    await pool.end();
    pool = null;
    console.log('🔌 Conexão com PostgreSQL fechada');
  } catch (err) {
    console.error('Erro ao fechar conexão:', err);
  }
}

// ========================
// 📞 FILA DE SUPORTE
// ========================

/**
 * Adiciona um paciente à fila de suporte.
 * @param {string} telefone - Número de telefone do paciente (somente dígitos, 10-11 chars).
 * @param {string} nome - Nome do paciente.
 * @returns {Object|null} Registro inserido ou null em caso de erro.
 */
async function adicionarFilaSuporte(telefone, nome) {
  const db = initDB();
  if (!db) return null;

  try {
    const result = await db.query(
      `INSERT INTO fila_suporte (telefone, nome, status, criado_em, atualizado_em)
       VALUES ($1, $2, 'aguardando', NOW(), NOW())
       RETURNING *`,
      [telefone, nome]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Erro ao adicionar à fila de suporte:', err);
    return null;
  }
}

/**
 * Retorna todos os pacientes com status 'aguardando', ordenados por criado_em ASC.
 * @returns {Array} Lista de registros da fila.
 */
async function getFilaSuporte() {
  const db = initDB();
  if (!db) return [];

  try {
    const result = await db.query(
      `SELECT * FROM fila_suporte
       WHERE status = 'aguardando'
       ORDER BY criado_em ASC`
    );
    return result.rows;
  } catch (err) {
    console.error('Erro ao buscar fila de suporte:', err);
    return [];
  }
}

/**
 * Marca um paciente como respondido e o remove da fila ativa.
 * @param {number} id - ID do registro na fila.
 * @returns {Object|null} Registro atualizado ou null se não encontrado/erro.
 */
async function responderFilaSuporte(id) {
  const db = initDB();
  if (!db) return null;

  try {
    const result = await db.query(
      `UPDATE fila_suporte
       SET status = 'respondido', atualizado_em = NOW()
       WHERE id = $1 AND status = 'aguardando'
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Erro ao responder fila de suporte:', err);
    return null;
  }
}

// ========================
// 📤 EXPORTAR TODAS AS FUNÇÕES
// ========================
module.exports = {
  initDB,
  getAtendimentos,
  salvarAtendimento,
  buscarAtendimentoPorId,
  atualizarStatusPagamento,
  atualizarStatus,
  getEstatisticas,
  getAtendimentosPorStatus,
  deletarAtendimento,
  deletarAtendimentosAntigos,
  healthCheck,
  closeConnection,
  adicionarFilaSuporte,
  getFilaSuporte,
  responderFilaSuporte
};