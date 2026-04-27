require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const fs = require('fs')
const path = require('path')

const app = express()  // <-- IMPORTANTE: instanciar o app
const PORT = process.env.PORT || 3002

const BASE_URL = process.env.BASE_URL 
  || (process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
    : `http://localhost:${PORT}`)

// ========================
// 🔐 VALIDAÇÃO DAS VARIÁVEIS
// ========================
;['ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'MEDICO_PASS'].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ ${v} não definida no .env`)
    process.exit(1)
  }
})

// Valida se ENCRYPTION_KEY tem 64 caracteres hexadecimais (32 bytes)
const encryptionKeyHex = process.env.ENCRYPTION_KEY
if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
  console.error('❌ ENCRYPTION_KEY deve ter 64 caracteres hexadecimais (32 bytes)')
  console.error('   Para gerar uma chave válida, execute:')
  console.error('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}
const key = Buffer.from(encryptionKeyHex, 'hex')
console.log('✅ ENCRYPTION_KEY válida')

// ========================
// 🔐 CRIPTOGRAFIA
// ========================
function encrypt(text) {
  if (!text) return null
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  if (!text) return null
  try {
    const [ivHex, data] = text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch {
    return null
  }
}

// ========================
// 💾 BANCO DE DADOS (FILE-BASED)
// ========================
const DB_DIR = 'data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = {
  salvar(at) {
    fs.writeFileSync(path.join(DB_DIR, `at_${at.id}.json`), JSON.stringify(at, null, 2))
  },
  get() {
    if (!fs.existsSync(DB_DIR)) return []
    return fs.readdirSync(DB_DIR)
      .filter(f => f.startsWith('at_'))
      .map(f => JSON.parse(fs.readFileSync(path.join(DB_DIR, f))))
  },
  find(id) {
    const file = path.join(DB_DIR, `at_${id}.json`)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null
  },
  update(id, data) {
    const at = this.find(id)
    if (!at) return
    Object.assign(at, data)
    this.salvar(at)
  }
}

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero, msg) {
  if (!numero || !process.env.ULTRAMSG_INSTANCE || !process.env.ULTRAMSG_TOKEN) {
    console.log('⚠️ WhatsApp não configurado, mensagem não enviada:', msg)
    return
  }
  try {
    await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token: process.env.ULTRAMSG_TOKEN,
        to: '+55' + numero.replace(/\D/g, ''),
        body: msg
      })
    )
    console.log('✅ WhatsApp enviado para:', numero)
  } catch (e) {
    console.error('❌ Erro WhatsApp:', e.message)
  }
}

// ========================
// 🛡️ MIDDLEWARES
// ========================
app.use(helmet({
  contentSecurityPolicy: {  // <-- CORRIGIDO: era 'entSecurityPolicy'
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc: ["'self'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  }
}))

app.set('trust proxy', 1)
app.use(cors())
app.use(express.json())

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}))

// ========================
// 🔐 AUTENTICAÇÃO
// ========================
function gerarToken() {
  return jwt.sign({ role: 'medico' }, process.env.JWT_SECRET, { expiresIn: '8h' })
}

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) throw new Error('Token não fornecido')
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'não autorizado' })
  }
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body
    
    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({ error: 'Dados incompletos. Necessário: paciente.nome e triagem.doencas' })
    }

    const id = crypto.randomUUID()
    const texto = triagem.doencas.toLowerCase()
    const elegivel = ['has', 'diabetes', 'hipertensão', 'pressão'].some(d => texto.includes(d))

    const at = {
      id,
      paciente_nome: encrypt(paciente.nome),
      paciente_telefone: encrypt(paciente.telefone || ''),
      doencas: encrypt(texto),
      elegivel,
      status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
      pagamento: false,
      createdAt: new Date().toISOString()
    }

    db.salvar(at)
    console.log(`✅ Triagem salva: ${id} - Elegível: ${elegivel}`)

    if (!elegivel) {
      await enviarWhatsApp(paciente.telefone, '❌ Não elegível para teleconsulta.')
    }

    res.json({ id, elegivel })
  } catch (error) {
    console.error('❌ Erro na triagem:', error)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ========================
// 💳 STRIPE CHECKOUT
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try {
    const at = db.find(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: { id: req.params.id },
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: { name: 'Consulta Médica' },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/cancel.html`
    })
    
    res.json({ url: session.url })
  } catch (error) {
    console.error('❌ Erro Stripe:', error)
    res.status(500).json({ error: 'Erro ao gerar pagamento' })
  }
})

// ========================
// 🔥 STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('❌ Webhook signature error:', err.message)
    return res.status(400).send('erro webhook')
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const id = session.metadata.id

    db.update(id, {
      pagamento: true,
      status: 'FILA',
      pagoEm: new Date().toISOString()
    })

    const at = db.find(id)
    const tel = decrypt(at.paciente_telefone)
    await enviarWhatsApp(tel, '💰 Pagamento confirmado. Você está na fila.')
    console.log(`✅ Pagamento confirmado para: ${id}`)
  }

  res.json({ received: true })
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login', (req, res) => {
  if (req.body.senha !== process.env.MEDICO_PASS) {
    return res.status(401).json({ error: 'senha inválida' })
  }
  res.json({ token: gerarToken() })
})

// ========================
// 📋 ROTAS PROTEGIDAS
// ========================
app.get('/api/atendimentos', auth, (req, res) => {
  const atendimentos = db.get().map(a => ({
    ...a,
    paciente_nome: decrypt(a.paciente_nome),
    paciente_telefone: decrypt(a.paciente_telefone),
    doencas: decrypt(a.doencas)
  }))
  res.json(atendimentos)
})

app.get('/api/estatisticas', auth, (req, res) => {
  const a = db.get()
  res.json({
    total: a.length,
    fila: a.filter(x => x.status === 'FILA').length,
    aprovados: a.filter(x => x.status === 'APROVADO').length,
    recusados: a.filter(x => x.status === 'RECUSADO').length,
    inelegiveis: a.filter(x => x.status === 'INELEGIVEL').length
  })
})

app.post('/api/decisao/:id', auth, async (req, res) => {
  const { decisao } = req.body
  const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
  db.update(req.params.id, { status: novoStatus })

  const at = db.find(req.params.id)
  const tel = decrypt(at.paciente_telefone)
  const nome = decrypt(at.paciente_nome)

  const msg = novoStatus === 'APROVADO'
    ? `✅ Olá ${nome}! Sua consulta foi APROVADA. A receita será enviada em breve.`
    : `❌ Olá ${nome}! Sua consulta foi RECUSADA. Para mais informações, entre em contato.`

  await enviarWhatsApp(tel, msg)
  res.json({ ok: true, status: novoStatus })
})

// ========================
// 📄 PÁGINAS ESTÁTICAS
// ========================

// Página de sucesso
app.get('/success.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Pagamento Confirmado</title>
    <style>
      body { font-family: Arial; text-align: center; padding: 50px; background: #e8f5e9; }
      .box { background: white; padding: 40px; border-radius: 16px; max-width: 500px; margin: 0 auto; }
      h1 { color: #2e7d32; }
      a { display: inline-block; margin-top: 20px; color: #1565c0; }
    </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ Pagamento Confirmado!</h1>
        <p>Seu pagamento foi processado com sucesso.</p>
        <p>Você receberá a análise médica em até 24h.</p>
        <a href="/painel-medico">Voltar ao painel</a>
      </div>
    </body>
    </html>
  `)
})

// Página de cancelamento
app.get('/cancel.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Pagamento Cancelado</title>
    <style>
      body { font-family: Arial; text-align: center; padding: 50px; background: #ffebee; }
      .box { background: white; padding: 40px; border-radius: 16px; max-width: 500px; margin: 0 auto; }
      h1 { color: #c62828; }
      a { display: inline-block; margin-top: 20px; color: #1565c0; }
    </style>
    </head>
    <body>
      <div class="box">
        <h1>❌ Pagamento Cancelado</h1>
        <p>Você cancelou o pagamento.</p>
        <p>Pode tentar novamente quando quiser.</p>
        <a href="/painel-medico">Voltar ao painel</a>
      </div>
    </body>
    </html>
  `)
})

// ========================
// 🏥 PAINEL MÉDICO (VERSÃO COMPLETA E CORRIGIDA)
// ========================
app.get('/painel-medico', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel Médico - Doctor Prescreve</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; }
    .login-area { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: linear-gradient(135deg, #1a6b8a, #0d4f6b); }
    .login-card { background: white; border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    .login-card h2 { color: #1a6b8a; margin-bottom: 24px; text-align: center; }
    .login-card input { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
    .login-card button { width: 100%; padding: 12px; background: #1a6b8a; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold; }
    .login-card button:hover { background: #0d4f6b; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; display: none; }
    .header { background: linear-gradient(135deg, #1a6b8a, #0d4f6b); color: white; padding: 20px; border-radius: 16px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 28px; }
    .logout-btn { background: rgba(255,255,255,0.2); border: 1px solid white; padding: 10px 20px; border-radius: 8px; cursor: pointer; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: white; border-radius: 16px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .stat-number { font-size: 36px; font-weight: bold; color: #1a6b8a; }
    .filtros { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .filtro-btn { background: #e9ecef; border: none; padding: 10px 24px; border-radius: 30px; cursor: pointer; }
    .filtro-btn.ativo { background: #1a6b8a; color: white; }
    .table-container { background: white; border-radius: 16px; overflow-x: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
    th { background: #f8f9fa; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge-aprovado { background: #d4edda; color: #155724; }
    .badge-recusado { background: #f8d7da; color: #721c24; }
    .badge-fila { background: #fff3cd; color: #856404; }
    .btn { padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; margin: 2px; font-weight: 600; }
    .btn-success { background: #28a745; color: white; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-info { background: #17a2b8; color: white; }
    .erro { color: #dc3545; text-align: center; margin-top: 10px; display: none; }
  </style>
</head>
<body>
  <div id="loginArea" class="login-area">
    <div class="login-card">
      <h2>🔐 Painel Médico</h2>
      <input type="password" id="senha" placeholder="Digite sua senha" onkeypress="if(event.key==='Enter') login()">
      <button onclick="login()">Entrar</button>
      <div id="erroMsg" class="erro">❌ Senha incorreta!</div>
    </div>
  </div>

  <div id="painel" class="container">
    <div class="header">
      <h1>📊 Doctor Prescreve - Painel Médico</h1>
      <button class="logout-btn" onclick="logout()">Sair</button>
    </div>
    <div class="stats" id="stats">Carregando...</div>
    <div class="filtros">
      <button class="filtro-btn ativo" onclick="filtrar('todos')">Todos</button>
      <button class="filtro-btn" onclick="filtrar('fila')">Na Fila</button>
      <button class="filtro-btn" onclick="filtrar('aprovados')">Aprovados</button>
      <button class="filtro-btn" onclick="filtrar('recusados')">Recusados</button>
    </div>
    <div class="table-container" id="lista">Carregando...</div>
  </div>

  <script>
    let token = ''
    let dados = []
    let filtro = 'todos'

    async function login() {
      const senha = document.getElementById('senha').value
      try {
        const res = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senha })
        })
        const data = await res.json()
        if (data.token) {
          token = data.token
          document.getElementById('loginArea').style.display = 'none'
          document.getElementById('painel').style.display = 'block'
          carregar()
        } else {
          document.getElementById('erroMsg').style.display = 'block'
        }
      } catch(e) {
        alert('Erro: ' + e.message)
      }
    }

    function logout() {
      token = ''
      document.getElementById('loginArea').style.display = 'flex'
      document.getElementById('painel').style.display = 'none'
    }

    async function carregar() {
      await carregarStats()
      await carregarAtendimentos()
    }

    async function carregarStats() {
      try {
        const res = await fetch('/api/estatisticas', { headers: { 'Authorization': 'Bearer ' + token } })
        const stats = await res.json()
        document.getElementById('stats').innerHTML = 
          '<div class="stat-card"><div class="stat-number">' + (stats.total || 0) + '</div><div>Total</div></div>' +
          '<div class="stat-card"><div class="stat-number">' + (stats.fila || 0) + '</div><div>Na Fila</div></div>' +
          '<div class="stat-card"><div class="stat-number">' + (stats.aprovados || 0) + '</div><div>Aprovados</div></div>' +
          '<div class="stat-card"><div class="stat-number">' + (stats.recusados || 0) + '</div><div>Recusados</div></div>'
      } catch(e) { console.error(e) }
    }

    async function carregarAtendimentos() {
      try {
        const res = await fetch('/api/atendimentos', { headers: { 'Authorization': 'Bearer ' + token } })
        dados = await res.json()
        renderizar()
      } catch(e) { console.error(e) }
    }

    function filtrar(tipo) {
      filtro = tipo
      document.querySelectorAll('.filtro-btn').forEach(btn => btn.classList.remove('ativo'))
      event.target.classList.add('ativo')
      renderizar()
    }

    function renderizar() {
      let filtrados = dados.filter(a => {
        if (filtro === 'fila') return a.status === 'FILA'
        if (filtro === 'aprovados') return a.status === 'APROVADO'
        if (filtro === 'recusados') return a.status === 'RECUSADO'
        return true
      })

      if (filtrados.length === 0) {
        document.getElementById('lista').innerHTML = '<div style="text-align:center;padding:40px">Nenhum atendimento encontrado</div>'
        return
      }

      let html = '<table><thead><tr><th>ID</th><th>Paciente</th><th>Doenças</th><th>Status</th><th>Ações</th></tr></thead><tbody>'
      for (const a of filtrados) {
        let badgeClass = a.status === 'APROVADO' ? 'badge-aprovado' : (a.status === 'RECUSADO' ? 'badge-recusado' : 'badge-fila')
        html += '<tr>' +
          '<td>' + a.id.substring(0, 8) + '</td>' +
          '<td>' + (a.paciente_nome || 'N/A') + '</td>' +
          '<td>' + (a.doencas || 'N/A') + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + a.status + '</span></td>' +
          '<td>' +
            '<button class="btn btn-info" onclick="verDetalhe(\'' + a.id + '\')">Ver</button>' +
            (a.status === 'FILA' ? 
              '<button class="btn btn-success" onclick="aprovar(\'' + a.id + '\')">Aprovar</button>' +
              '<button class="btn btn-danger" onclick="recusar(\'' + a.id + '\')">Recusar</button>' : '') +
          '</td>' +
        '</tr>'
      }
      html += '</tbody></table>'
      document.getElementById('lista').innerHTML = html
    }

    function verDetalhe(id) {
      const a = dados.find(x => x.id === id)
      if (a) {
        alert('ID: ' + a.id + '\nPaciente: ' + (a.paciente_nome || 'N/A') + '\nTelefone: ' + (a.paciente_telefone || 'N/A') + '\nDoenças: ' + (a.doencas || 'N/A'))
      }
    }

    async function aprovar(id) {
      if (!confirm('Aprovar este paciente?')) return
      await fetch('/api/decisao/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ decisao: 'APROVAR' })
      })
      carregar()
    }

    async function recusar(id) {
      if (!confirm('Recusar este paciente?')) return
      await fetch('/api/decisao/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ decisao: 'RECUSAR' })
      })
      carregar()
    }

    setInterval(() => { if (token) carregar() }, 30000)
  </script>
</body>
</html>`)
})

// ========================
// HEALTH CHECK
// ========================
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ========================
// ROTA RAIZ
// ========================
app.get('/', (req, res) => {
  res.json({
    nome: 'Doctor Prescreve API',
    versao: '1.0.0',
    endpoints: {
      triagem: 'POST /api/webhook/triagem',
      pagamento: 'GET /api/payment/:id',
      webhook_stripe: 'POST /webhook/stripe',
      login: 'POST /login',
      painel: 'GET /painel-medico',
      atendimentos: 'GET /api/atendimentos',
      estatisticas: 'GET /api/estatisticas',
      decisao: 'POST /api/decisao/:id'
    }
  })
})

// ========================
// 🚀 INICIAR SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(50))
  console.log('🚀 Servidor Doctor Prescreve')
  console.log('='.repeat(50))
  console.log(`📡 Porta: ${PORT}`)
  console.log(`🌍 URL: ${BASE_URL}`)
  console.log(`🏥 Painel Médico: ${BASE_URL}/painel-medico`)
  console.log('='.repeat(50))
  console.log('✅ Servidor rodando!\n')
})
