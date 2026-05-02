require('dotenv').config()

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const helmet = require('helmet')

const app = express()
const PORT = process.env.PORT || 3002

app.use(cors())
app.use(express.json())
app.use(helmet())

// ========================
// 🔐 CRIPTOGRAFIA
// ========================

const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex')

function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  const [ivHex, data] = text.split(':')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
}

// ========================
// 🔐 AUTH
// ========================

const gerarToken = () => jwt.sign({ role: 'medico' }, process.env.JWT_SECRET)

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Não autorizado' })
  }
}

// ========================
// 💾 DB SIMPLES
// ========================

const fs = require('fs')
const path = require('path')

const DB_DIR = 'data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR)

const db = {
  salvar(at) {
    fs.writeFileSync(path.join(DB_DIR, `${at.id}.json`), JSON.stringify(at))
  },
  buscar(id) {
    const file = path.join(DB_DIR, `${id}.json`)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null
  }
}
app.post('/api/webhook/triagem', async (req, res) => {
  const { paciente, triagem } = req.body

  const id = crypto.randomUUID()

  const atendimento = {
    id,
    paciente_nome: encrypt(paciente.nome),
    condicao: encrypt(triagem.doencas),
    status: 'AGUARDANDO_PAGAMENTO',
    criado_em: new Date()
  }

  db.salvar(atendimento)

  res.json({ success: true, id })
})

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

app.get('/api/payment/:id', async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'brl',
        product_data: { name: 'Consulta' },
        unit_amount: 6990
      },
      quantity: 1
    }],
    success_url: 'http://localhost:3002/success',
    cancel_url: 'http://localhost:3002/cancel'
  })

  res.json({ url: session.url })
})

// ========================
// 🧠 MOTOR CLÍNICO
// ========================

function detectarTipo(texto) {
  if (!texto) return 'OUTRO'
  if (texto.includes('hipert') || texto.includes('pressão')) return 'HAS'
  if (texto.includes('diabetes')) return 'DIABETES'
  if (texto.includes('tireo')) return 'HIPOTIREOIDISMO'
  return 'OUTRO'
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function gerarQueixa(tipo) {
  const base = {
    HAS: [
      "Paciente em acompanhamento por hipertensão arterial.",
      "Paciente com diagnóstico prévio de HAS.",
      "Paciente solicita renovação de anti-hipertensivo."
    ],
    DIABETES: [
      "Paciente em acompanhamento por diabetes mellitus.",
      "Paciente em uso contínuo de hipoglicemiante.",
      "Paciente solicita continuidade do tratamento."
    ],
    HIPOTIREOIDISMO: [
      "Paciente com hipotireoidismo em tratamento.",
      "Paciente em uso contínuo de levotiroxina.",
      "Paciente solicita renovação de medicação."
    ]
  }
  return pick(base[tipo] || ["Paciente em acompanhamento clínico."])
}

function gerarHistoria(tipo) {
  return "Paciente refere estabilidade do quadro clínico, sem intercorrências recentes."
}

function gerarConduta(tipo) {
  return "Manter tratamento atual. Orientado acompanhamento regular."
}

function gerarMedicacao(tipo) {
  const mapa = {
    HAS: "Losartana 50mg",
    DIABETES: "Metformina 850mg",
    HIPOTIREOIDISMO: "Levotiroxina 50mcg"
  }
  return mapa[tipo] || "Uso contínuo conforme prescrição"
}

function gerarProntuario(at) {
  const condicao = JSON.parse(decrypt(at.condicao || '{}'))

  return {
    queixa: gerarQueixa(condicao.tipo),
    historia: gerarHistoria(condicao.tipo),
    conduta: gerarConduta(condicao.tipo),
    medicacao: gerarMedicacao(condicao.tipo)
  }
}

// ========================
// 🧠 TRIAGEM (CORRIGIDA)
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({ 
        error: 'Dados inválidos. Requeridos: paciente.nome, triagem.doencas' 
      })
    }

    const { v4: uuidv4 } = require('uuid')
    const id = uuidv4()
    const texto = triagem.doencas.toLowerCase()
    const tipo = detectarTipo(texto)
    
    const doencasElegiveis = ['has', 'diabetes', 'hipertensão', 'pressão', 'hipotireoidismo', 'dislipidemia']
    const elegivel = doencasElegiveis.some(d => texto.includes(d))

    const atendimento = {
      id,
      paciente_nome: encrypt(paciente.nome),
      paciente_telefone: encrypt(paciente.telefone || ''),
      paciente_cpf: encrypt(paciente.cpf || ''),
      paciente_email: encrypt(paciente.email || ''),
      condicao: encrypt(JSON.stringify({
        doenca: texto,
        tipo,
        risco: "baixo"
      })),
      elegivel,
      status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
      pagamento: false,
      criado_em: new Date().toISOString()
    }

    await db.salvarAtendimento(atendimento)

    if (elegivel) {
      const url = `${BASE_URL}/api/payment/${id}`
      const msg = `👋 Olá ${paciente.nome}!\n\n✅ Sua triagem foi aprovada!\n\n💳 Clique para pagar:\n${url}\n\n💰 R$ 69,90\n\n🔐 Consulta Assíncrona Segura`
      await enviarWhatsAppOficial(paciente.telefone, msg)
    } else {
      const msg = `❌ Infelizmente, sua condição não se qualifica para renovação remota.\nProcure atendimento presencial.`
      await enviarWhatsAppOficial(paciente.telefone, msg)
    }

    res.status(201).json({
      success: true,
      id,
      elegivel,
      atendimentoId: id,
      mensagem: elegivel ? 'Elegível. Link de pagamento enviado por WhatsApp' : 'Não elegível'
    })
  } catch(e) {
    console.error('❌ Erro em triagem:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📋 PRONTUÁRIO AUTOMÁTICO
// ========================
app.get('/api/prontuario/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) return res.status(404).json({ error: 'Não encontrado' })

    const prontuario = gerarProntuario(at)

    res.json({
      paciente: {
        nome: decrypt(at.paciente_nome),
        cpf: decrypt(at.paciente_cpf),
        telefone: decrypt(at.paciente_telefone),
        email: decrypt(at.paciente_email)
      },
      condicao: JSON.parse(decrypt(at.condicao || '{}')),
      ...prontuario
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🚀 SERVER
// ========================

app.get('/', (req, res) => {
  res.json({ status: 'online', versao: '1.0' })
})

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`)
})
