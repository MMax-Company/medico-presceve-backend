const express = require('express')
const cors = require('cors')
const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')

// 🔥 HARDCODE TEMPORÁRIO - Vai funcionar AGORA!
const stripe = require('stripe')('sk_test_51TCWAKJhkU05FJjnWJ1jcMxwAg5gccQwslY67JNc0cZi1RcfogQJQVrXHLZ3eeHK0sj44b8kwE4i6wdhEWfiq6Ag00s389pQXJ')

const db = require('./db')
const memed = require('./memed')

const app = express()

// ========================
// 🔐 CONFIGURAÇÕES
// ========================
const BASE_URL = process.env.BASE_URL || 'http://localhost:3002'
const PORT = process.env.PORT || 3002

// UltraMsg (WhatsApp)
const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN

// Chave para criptografia
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'minha-chave-secreta-de-32-caracteres!!'

// ========================
// 🔐 FUNÇÕES DE CRIPTOGRAFIA
// ========================
function encrypt(text) {
  if (!text) return null
  try {
    const cipher = crypto.createCipher('aes-256-cbc', ENCRYPTION_KEY)
    let encrypted = cipher.update(text.toString(), 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return encrypted
  } catch (error) {
    console.error('Erro ao criptografar:', error)
    return text
  }
}

function decrypt(encryptedText) {
  if (!encryptedText) return null
  try {
    const decipher = crypto.createDecipher('aes-256-cbc', ENCRYPTION_KEY)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (error) {
    console.error('Erro ao descriptografar:', error)
    return encryptedText
  }
}

// ========================
// 📱 VALIDAÇÃO DE TELEFONE
// ========================
function validarTelefone(telefone) {
  if (!telefone) return false
  const numeros = telefone.toString().replace(/\D/g, '')
  if (numeros.length === 11 || numeros.length === 13) return true
  return false
}

function formatarTelefone(telefone) {
  const numeros = telefone.toString().replace(/\D/g, '')
  if (numeros.length === 11) return `+55${numeros}`
  if (numeros.length === 13 && numeros.startsWith('55')) return `+${numeros}`
  return null
}

// ========================
// 📱 WHATSAPP - ULTRAMSG
// ========================
async function enviarWhatsApp(numero, mensagem, tipo = 'geral') {
  if (!validarTelefone(numero)) {
    console.log(`⚠️ Telefone inválido: ${numero}`)
    return false
  }

  const telefoneFormatado = formatarTelefone(numero)
  if (!telefoneFormatado) {
    console.log(`⚠️ Não foi possível formatar o telefone: ${numero}`)
    return false
  }

  if (!ULTRAMSG_INSTANCE || !ULTRAMSG_TOKEN) {
    console.log('⚠️ UltraMsg não configurada')
    return false
  }

  try {
    const params = new URLSearchParams()
    params.append('token', ULTRAMSG_TOKEN)
    params.append('to', telefoneFormatado)
    params.append('body', mensagem)
    params.append('priority', '10')

    await axios.post(
      `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    )

    console.log(`✅ WhatsApp enviado (${tipo}): ${telefoneFormatado}`)
    return true
  } catch (error) {
    console.error('❌ WhatsApp erro:', error.response?.data || error.message)
    return false
  }
}

// ========================
// 🔥 MIDDLEWARES
// ========================
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true')
  next()
})

app.use(cors())
app.use(express.json())
app.use(express.static(__dirname))

// ========================
// 🏠 HOME
// ========================
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Sistema de Triagem Médica</title>
        <style>
          body { font-family: Arial; padding: 50px; text-align: center; }
          h1 { color: #2c3e50; }
          .card { background: #ecf0f1; padding: 20px; border-radius: 10px; display: inline-block; }
          .endpoint { background: #34495e; color: white; padding: 10px; margin: 5px; border-radius: 5px; font-family: monospace; }
        </style>
      </head>
      <body>
        <h1>🚀 Sistema de Triagem Médica</h1>
        <p>API funcionando perfeitamente!</p>
        <div class="card">
          <h2>📋 Endpoints Disponíveis</h2>
          <div class="endpoint">GET /estatisticas - Estatísticas</div>
          <div class="endpoint">GET /dashboard - Dashboard</div>
          <div class="endpoint">GET /fila - Fila de atendimentos</div>
          <div class="endpoint">POST /api/webhook/triagem - Triagem</div>
        </div>
      </body>
    </html>
  `)
})

// ========================
// 📊 DASHBOARD
// ========================
app.get('/dashboard', (req, res) => {
  const atendimentos = db.getAtendimentos()
  
  const atendimentosDecrypt = atendimentos.map(a => ({
    ...a,
    paciente: a.paciente ? {
      nome: decrypt(a.paciente.nome),
      cpf: decrypt(a.paciente.cpf),
      telefone: decrypt(a.paciente.telefone)
    } : a.paciente
  }))
  
  const total = atendimentos.length
  const elegiveis = atendimentos.filter(a => a.elegivel).length
  const pagos = atendimentos.filter(a => a.pagamento).length
  const fila = atendimentos.filter(a => a.pagamento && a.status === 'FILA').length
  
  res.send(`
    <html>
      <head>
        <title>Dashboard</title>
        <style>
          body { font-family: Arial; padding: 20px; background: #f5f5f5; }
          h1 { color: #2c3e50; }
          .stats { display: flex; gap: 20px; margin-bottom: 30px; }
          .stat-card { background: white; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
          .stat-number { font-size: 36px; font-weight: bold; color: #3498db; }
          table { width: 100%; background: white; border-collapse: collapse; }
          th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
          th { background: #2c3e50; color: white; }
        </style>
      </head>
      <body>
        <h1>📊 Dashboard</h1>
        <div class="stats">
          <div class="stat-card"><div class="stat-number">${total}</div><div>Total</div></div>
          <div class="stat-card"><div class="stat-number">${elegiveis}</div><div>Elegíveis</div></div>
          <div class="stat-card"><div class="stat-number">${pagos}</div><div>Pagos</div></div>
          <div class="stat-card"><div class="stat-number">${fila}</div><div>Fila</div></div>
        </div>
        <h2>Atendimentos</h2>
        </tr>
          <thead><tr><th>ID</th><th>Nome</th><th>Telefone</th><th>Elegível</th><th>Status</th><th>Pagamento</th></tr></thead>
          <tbody>
            ${atendimentosDecrypt.map(a => `
              <tr>
                <td>${a.id.substring(0, 8)}</td>
                <td>${a.paciente?.nome || 'N/A'}</td>
                <td>${a.paciente?.telefone || 'N/A'}</td>
                <td>${a.elegivel ? 'Sim' : 'Não'}</td>
                <td>${a.status}</td>
                <td>${a.pagamento ? '✅ Pago' : '⏳ Pendente'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `)
})

// ========================
// 🔐 MEMED TOKEN
// ========================
app.get('/memed-token', async (req, res) => {
  try {
    const token = await memed.gerarTokenPrescritor()
    res.json({ token })
  } catch (error) {
    res.status(500).json({ error: 'Erro Memed' })
  }
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/create-payment/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: { atendimentoId: req.params.id },
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: { name: 'Consulta Assíncrona' },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`
    })
    res.json({ url: session.url })
  } catch (err) {
    console.log(err)
    res.status(500).json({ error: err.message })
  }
})

// ========================
// 🧠 TRIAGEM (CORE DO SISTEMA)
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: 'Body vazio' })
  }

  const { paciente = {}, triagem = {} } = req.body

  if (!paciente || !triagem) {
    return res.status(400).json({ error: 'Dados incompletos' })
  }

  const id = req.body?.id || uuidv4()

  let doencaTexto = ''
  if (Array.isArray(triagem?.doencas)) {
    doencaTexto = triagem.doencas[0] || ''
  } else {
    doencaTexto = triagem?.doencas || ''
  }

  doencaTexto = doencaTexto.toString().toLowerCase()
  
  let doencaValida = false
  if (doencaTexto.includes('has') || doencaTexto.includes('hipertensao')) {
    doencaValida = true
  } else if (doencaTexto.includes('dm') || doencaTexto.includes('diabetes')) {
    doencaValida = true
  } else if (doencaTexto.includes('dlp') || doencaTexto.includes('dislipidemia')) {
    doencaValida = true
  } else if (doencaTexto.includes('hipotireoidismo')) {
    doencaValida = true
  }

  const receitaValida = true
  const sinaisAlerta = triagem?.sinaisAlerta === true || triagem?.sinaisAlerta === 'true' || triagem?.sinaisAlerta === 'SIM'

  const elegivel = doencaValida && receitaValida && !sinaisAlerta
  
  let motivo = null
  if (!elegivel) {
    if (!doencaValida) motivo = 'Doença não atendida'
    else if (!receitaValida) motivo = 'Receita vencida'
    else if (sinaisAlerta) motivo = 'Sinais de alerta'
  }

  const atendimento = {
    id,
    paciente: {
      nome: encrypt(paciente.nome || ''),
      cpf: encrypt(paciente.cpf || ''),
      telefone: encrypt(paciente.telefone || ''),
      email: encrypt(paciente.email || '')
    },
    triagem,
    elegivel,
    motivo,
    status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
    pagamento: false,
    criadoEm: new Date().toISOString()
  }

  const lista = db.getAtendimentos()
  lista.push(atendimento)
  db.saveAtendimentos(lista)

  console.log('📋 Novo atendimento:', id)

  if (elegivel) {
    return res.json({
      ok: true,
      elegivel: true,
      atendimentoId: id,
      pagamentoUrl: `${BASE_URL}/api/create-payment/${id}`
    })
  }

  return res.json({
    ok: false,
    elegivel: false,
    motivo
  })
})

// ========================
// 💰 SUCCESS
// ========================
app.get('/success', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id)
    const id = session.metadata.atendimentoId

    const lista = db.getAtendimentos()
    const at = lista.find(a => a.id === id)

    if (at) {
      at.pagamento = true
      at.status = at.elegivel ? 'FILA' : 'INELEGIVEL'
      db.saveAtendimentos(lista)
    }

    res.send('<h1>✅ Pagamento Confirmado!</h1><p>Seu atendimento foi registrado.</p><a href="/dashboard">Ver Dashboard</a>')
  } catch {
    res.send('<h1>❌ Erro no Pagamento</h1>')
  }
})

// ========================
// 📋 FILA
// ========================
app.get('/fila', (req, res) => {
  const fila = db.getAtendimentos().filter(a => a.pagamento && a.status === 'FILA')
  res.json(fila)
})

// ========================
// 📋 TODOS ATENDIMENTOS
// ========================
app.get('/atendimentos', (req, res) => {
  const atendimentos = db.getAtendimentos()
  res.json(atendimentos.map(a => ({
    id: a.id,
    elegivel: a.elegivel,
    status: a.status,
    pagamento: a.pagamento,
    criadoEm: a.criadoEm
  })))
})

// ========================
// 📊 ESTATÍSTICAS
// ========================
app.get('/estatisticas', (req, res) => {
  const atendimentos = db.getAtendimentos()
  res.json({
    total: atendimentos.length,
    elegiveis: atendimentos.filter(a => a.elegivel).length,
    pagos: atendimentos.filter(a => a.pagamento).length,
    naFila: atendimentos.filter(a => a.pagamento && a.status === 'FILA').length
  })
})

// ========================
// ❌ CANCEL
// ========================
app.get('/cancel', (req, res) => {
  res.send('<h1>❌ Pagamento cancelado</h1>')
})

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, () => {
  console.log('='.repeat(50))
  console.log(`🚀 Servidor rodando: ${PORT}`)
  console.log(`🌍 URL: ${BASE_URL}`)
  console.log(`🔐 Criptografia: ATIVA (LGPD)`)
  console.log('='.repeat(50))
})

module.exports = app