require('dotenv').config()

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const helmet = require('helmet')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const PDFDocument = require('pdfkit')
const QRCode = require('qrcode')

// ========================
// 🔌 IMPORTAR MÓDULO DE BANCO (PostgreSQL)
// ========================
const db = require('./db')

// ========================
// 🚀 CONFIGURAÇÃO DO EXPRESS
// ========================
const app = express()
const PORT = process.env.PORT || 3002
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`

// ========================
// ⚠️ WEBHOOK STRIPE (deve vir ANTES do express.json global)
// O Stripe precisa do body raw para verificar assinatura
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado. Pulando verificação.')
    // Tentar parsear o body manualmente
    let body
    try {
      body = JSON.parse(req.body.toString())
    } catch (e) {
      return res.status(400).json({ error: 'Body inválido' })
    }
    return res.json({ received: true })
  }

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )

    console.log(`📡 Webhook recebido: ${event.type}`)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const atendimentoId = session.metadata?.atendimentoId

      if (!atendimentoId) {
        console.error('❌ Webhook: atendimentoId não encontrado')
        return res.json({ received: true })
      }

      const at = await db.buscarAtendimentoPorId(atendimentoId)

      if (!at) {
        console.error(`❌ Atendimento não encontrado: ${atendimentoId}`)
        return res.json({ received: true })
      }

      if (at.pagamento) {
        console.log(`⚠️ Pagamento já processado para: ${atendimentoId}`)
        return res.json({ received: true })
      }

      await db.atualizarStatusPagamento(atendimentoId, true, 'FILA')

      const telefone = safeDecrypt(at.paciente_telefone)
      const nome = safeDecrypt(at.paciente_nome)

      if (telefone) {
        const msg = `✅ Pagamento confirmado, ${nome}!\n\n👨‍⚕️ Seu atendimento entrou na fila.\n\n⏳ Você receberá a resposta em até 24h.`
        await enviarWhatsAppOficial(telefone, msg)
      }

      console.log(`✅ Pagamento processado para: ${nome} (${atendimentoId})`)
    }

    res.json({ received: true })

  } catch (e) {
    console.error('❌ Erro no webhook do Stripe:', e.message)
    res.status(400).send(`Webhook Error: ${e.message}`)
  }
})

// ========================
// 🛡️ MIDDLEWARES GLOBAIS
// ========================
app.use(cors())
app.use(express.json())
app.use(helmet())

// ========================
// 📱 FUNÇÃO WHATSAPP (MODO TESTE)
// ========================
const WHATSAPP_MODE = process.env.WHATSAPP_MODE || 'test'

async function enviarWhatsAppOficial(telefone, mensagem) {
  if (WHATSAPP_MODE === 'test') {
    console.log(`\n📱 [MODO TESTE] WhatsApp NÃO enviado`)
    console.log(`   Para: ${telefone}`)
    console.log(`   Mensagem: ${mensagem.substring(0, 100)}...\n`)
    return true
  }

  try {
    const axios = require('axios')
    const response = await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      {
        token: process.env.ULTRAMSG_TOKEN,
        to: telefone,
        body: mensagem
      }
    )
    return response.data.success === true
  } catch (error) {
    console.error('❌ Erro WhatsApp:', error.message)
    return false
  }
}

// ========================
// 🔐 CRIPTOGRAFIA
// ========================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY

function getEncryptionKey() {
  if (!ENCRYPTION_KEY) {
    console.warn('⚠️ ENCRYPTION_KEY não configurada. Criptografia desabilitada.')
    return null
  }
  return Buffer.from(ENCRYPTION_KEY, 'hex')
}

function encrypt(text) {
  if (!text) return ''
  const key = getEncryptionKey()
  if (!key) return text // fallback: retorna texto sem criptografar
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  if (!text) return ''
  const key = getEncryptionKey()
  if (!key) return text // fallback: retorna texto sem descriptografar
  try {
    const [ivHex, data] = text.split(':')
    if (!ivHex || !data) return text // não está criptografado
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch (e) {
    console.warn('⚠️ Falha ao descriptografar, retornando texto original')
    return text
  }
}

// Helper seguro para descriptografar (não lança exceção)
function safeDecrypt(text) {
  try {
    return decrypt(text)
  } catch (e) {
    return text || ''
  }
}

// ========================
// 🔐 AUTH (JWT)
// ========================
function gerarToken() {
  return jwt.sign(
    { role: 'medico', timestamp: Date.now() },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )
}

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]

    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.usuario = decoded
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' })
  }
}

// ========================
// 💾 DIRETÓRIO LOCAL PARA RECEITAS (complementar ao PostgreSQL)
// ========================
const DB_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

// ========================
// 🧠 MOTOR CLÍNICO
// ========================
function detectarTipo(texto) {
  if (!texto) return 'OUTRO'
  const lowerText = typeof texto === 'string' ? texto.toLowerCase() : String(texto).toLowerCase()

  if (lowerText.includes('hipert') || lowerText.includes('pressão') || lowerText.includes('pressao')) return 'HAS'
  if (lowerText.includes('diabetes') || lowerText.includes('açucar') || lowerText.includes('acucar')) return 'DIABETES'
  if (lowerText.includes('tireo') || lowerText.includes('hipotireoidismo')) return 'HIPOTIREOIDISMO'
  if (lowerText.includes('colesterol') || lowerText.includes('dislipidemia')) return 'DISLIPIDEMIA'
  if (lowerText.includes('ansiedade') || lowerText.includes('depressão') || lowerText.includes('depressao')) return 'SAUDE_MENTAL'

  return 'OUTRO'
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function gerarQueixa(tipo, dadosExtras = {}) {
  const base = {
    HAS: [
      "Paciente em acompanhamento por hipertensão arterial sistêmica.",
      "Paciente com diagnóstico prévio de HAS há 5 anos.",
      "Paciente solicita renovação de anti-hipertensivo, nega sintomas.",
      "Paciente relata pressão controlada com medicação atual.",
      "Paciente em uso regular de anti-hipertensivo, assintomático."
    ],
    DIABETES: [
      "Paciente em acompanhamento por diabetes mellitus tipo 2.",
      "Paciente em uso contínuo de hipoglicemiante oral.",
      "Paciente solicita continuidade do tratamento para diabetes.",
      "Paciente relata glicemias controladas nos últimos 3 meses.",
      "Paciente nega complicações micro/macrovasculares."
    ],
    HIPOTIREOIDISMO: [
      "Paciente com hipotireoidismo em tratamento com levotiroxina.",
      "Paciente em uso contínuo de levotiroxina, assintomático.",
      "Paciente solicita renovação de medicação para tireoide.",
      "Paciente relata boa adesão ao tratamento hormonal."
    ],
    DISLIPIDEMIA: [
      "Paciente com dislipidemia mista em tratamento.",
      "Paciente em uso de estatinas, refere boa tolerância.",
      "Paciente solicita renovação de medicação para colesterol."
    ],
    SAUDE_MENTAL: [
      "Paciente em acompanhamento por transtorno de ansiedade.",
      "Paciente em uso regular de ansiolítico, nega crises.",
      "Paciente refere estabilidade do quadro mental."
    ],
    OUTRO: [
      "Paciente em acompanhamento clínico geral.",
      "Paciente solicita renovação de medicação de uso contínuo.",
      "Paciente comparece para consulta de rotina."
    ]
  }
  return pick(base[tipo] || base.OUTRO)
}

function gerarHistoria(tipo, dadosExtras = {}) {
  const historias = {
    HAS: "Paciente refere estabilidade do quadro pressórico. Nega cefaleia, tontura ou palpitações. Sem internações recentes. Adesão ao tratamento relatada.",
    DIABETES: "Paciente nega poliúria, polidipsia ou polifagia. Refere seguimento com nutricionista. Realiza monitorização glicêmica esporádica.",
    HIPOTIREOIDISMO: "Paciente nega ganho ponderal excessivo, astenia ou intolerância ao frio. Refere boa energia para atividades diárias.",
    DISLIPIDEMIA: "Paciente relata dieta hipolipídica. Nega eventos cardiovasculares prévios.",
    SAUDE_MENTAL: "Paciente relata melhora do humor e ansiedade com medicação atual. Nega ideação suicida.",
    OUTRO: "Paciente refere-se assintomático ao momento. Sem intercorrências desde último atendimento."
  }
  return historias[tipo] || historias.OUTRO
}

function gerarExameFisico(tipo) {
  const exames = {
    HAS: "PA: 120x80 mmHg (aferido em farmácia). FC: 72 bpm. Sem outras alterações.",
    DIABETES: "Paciente eutrófico. Sem lesões de pele. Extremidades preservadas.",
    HIPOTIREOIDISMO: "Tireoide palpável sem nódulos. Sem bócio. Reflexos normais.",
    OUTRO: "Sem alterações significativas ao exame remoto."
  }
  return exames[tipo] || exames.OUTRO
}

function gerarConduta(tipo, dadosExtras = {}) {
  const condutas = {
    HAS: "Manter tratamento atual com anti-hipertensivo. Orientado acompanhamento regular com aferição pressórica domiciliar. Retorno em 3 meses.",
    DIABETES: "Manter hipoglicemiante oral. Reforçar orientação sobre dieta e atividade física. Solicitar HbA1c para próximo retorno.",
    HIPOTIREOIDISMO: "Manter levotiroxina na dose atual. Solicitar TSH para controle em 6 semanas.",
    DISLIPIDEMIA: "Manter estatina. Reforçar orientação dietética e atividade física.",
    SAUDE_MENTAL: "Manter medicação atual. Orientado psicoterapia de suporte.",
    OUTRO: "Manter tratamento habitual. Orientado retorno em 3 meses ou se necessário."
  }
  return condutas[tipo] || condutas.OUTRO
}

function gerarMedicacao(tipo, dadosExtras = {}) {
  const mapa = {
    HAS: "Losartana 50mg",
    DIABETES: "Metformina 850mg",
    HIPOTIREOIDISMO: "Levotiroxina 50mcg",
    DISLIPIDEMIA: "Atorvastatina 20mg",
    SAUDE_MENTAL: "Sertralina 50mg"
  }
  return mapa[tipo] || "Conforme prescrição médica habitual"
}

function gerarPosologia(tipo) {
  const posologias = {
    HAS: "1 comprimido ao dia, pela manhã",
    DIABETES: "1 comprimido 2 vezes ao dia, junto às refeições",
    HIPOTIREOIDISMO: "1 comprimido ao dia, em jejum",
    DISLIPIDEMIA: "1 comprimido ao dia, à noite",
    SAUDE_MENTAL: "1 comprimido ao dia, pela manhã"
  }
  return posologias[tipo] || "Uso contínuo conforme orientação médica"
}

function gerarRecomendacoes(tipo) {
  const recomendacoes = {
    HAS: "- Redução do sódio na dieta\n- Prática regular de exercícios\n- Evitar bebidas alcoólicas",
    DIABETES: "- Controle de carboidratos\n- Monitorização glicêmica\n- Atividade física regular",
    HIPOTIREOIDISMO: "- Tomar medicação em jejum\n- Aguardar 30 min para café da manhã\n- Evitar antiácidos próximo ao horário",
    OUTRO: "- Manter estilo de vida saudável\n- Hidratação adequada\n- Retorno conforme agendado"
  }
  return recomendacoes[tipo] || recomendacoes.OUTRO
}

function calcularScoreRisco(tipo, dadosExtras = {}) {
  const riscos = {
    HAS: Math.random() < 0.3 ? "MODERADO" : "BAIXO",
    DIABETES: Math.random() < 0.4 ? "MODERADO" : "BAIXO",
    HIPOTIREOIDISMO: "BAIXO",
    DISLIPIDEMIA: "BAIXO",
    SAUDE_MENTAL: "MODERADO"
  }
  return riscos[tipo] || "BAIXO"
}

// Helper: normalizar doencas (pode vir como string ou array)
function normalizarDoencas(doencas) {
  if (Array.isArray(doencas)) {
    return doencas.join(', ').toLowerCase()
  }
  if (typeof doencas === 'string') {
    return doencas.toLowerCase()
  }
  return String(doencas || '').toLowerCase()
}

// ========================
// 🏥 HEALTH CHECK
// ========================
app.get('/healthz', async (req, res) => {
  try {
    const dbOk = await db.healthCheck()
    res.json({
      status: 'online',
      database: dbOk ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    })
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message })
  }
})

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '2.0',
    ambiente: process.env.NODE_ENV || 'development',
    endpoints: {
      healthz: '/healthz',
      triagem: 'POST /api/webhook/triagem',
      pagamento: 'GET /api/payment/:id',
      login: 'POST /login'
    }
  })
})

// ========================
// 🔐 LOGIN
// ========================
app.post('/login', (req, res) => {
  try {
    const { senha } = req.body

    if (!senha) {
      return res.status(400).json({ error: 'Senha é obrigatória' })
    }

    if (senha !== process.env.MEDICO_PASS) {
      return res.status(401).json({ error: 'Senha inválida' })
    }

    const token = gerarToken()

    res.json({
      success: true,
      token: token,
      mensagem: 'Login realizado com sucesso',
      expira_em: '8 horas'
    })
  } catch (e) {
    console.error('❌ Erro no login:', e.message)
    res.status(500).json({ error: 'Erro interno no servidor' })
  }
})

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({
        error: 'Dados inválidos. Requeridos: paciente.nome, triagem.doencas'
      })
    }

    const id = uuidv4()
    const texto = normalizarDoencas(triagem.doencas)
    const tipo = detectarTipo(texto)

    const doencasElegiveis = ['has', 'diabetes', 'hipertensão', 'hipertensao', 'pressão', 'pressao', 'hipotireoidismo', 'dislipidemia']
    const elegivel = doencasElegiveis.some(d => texto.includes(d))

    // Dados criptografados para LGPD
    const paciente_nome = encrypt(paciente.nome)
    const paciente_telefone = encrypt(paciente.telefone || '')
    const paciente_cpf = encrypt(paciente.cpf || '')
    const paciente_email = encrypt(paciente.email || '')

    const triagemData = {
      doenca: texto,
      tipo,
      risco: "baixo"
    }

    // Salvar no banco PostgreSQL (formato compatível com db.js)
    const atendimento = {
      id,
      paciente: {
        nome: paciente_nome,
        cpf: paciente_cpf,
        telefone: paciente_telefone,
        email: paciente_email,
        data_nascimento: paciente.data_nascimento || null
      },
      triagem: triagemData,
      elegivel,
      motivo: elegivel ? 'Condição elegível para renovação remota' : 'Condição não elegível para renovação remota',
      status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
      pagamento: false,
      criadoEm: new Date().toISOString()
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
  } catch (e) {
    console.error('❌ Erro em triagem:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 💳 PAGAMENTO (STRIPE)
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const atendimentoId = req.params.id

    const at = await db.buscarAtendimentoPorId(atendimentoId)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'pix'],
      metadata: {
        atendimentoId: atendimentoId
      },
      line_items: [{
        price_data: {
          currency: process.env.CURRENCY || 'brl',
          product_data: {
            name: process.env.PRODUCT_NAME || 'Consulta Assíncrona - Doctor Prescreve',
            description: 'Renovação de receita médica com avaliação de médico licenciado',
            images: ['https://images.unsplash.com/photo-1576091160550-112173f7f869?w=500']
          },
          unit_amount: parseInt(process.env.PRODUCT_PRICE) || 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`
    })

    console.log(`💳 Sessão Stripe criada: ${session.id} para atendimento: ${atendimentoId}`)

    res.json({
      url: session.url,
      sessionId: session.id,
      paymentId: session.id
    })

  } catch (e) {
    console.error('❌ Erro ao criar sessão Stripe:', e.message)
    res.status(500).json({ error: 'Erro ao gerar pagamento: ' + e.message })
  }
})

// ========================
// ✅ VERIFICAR STATUS DO PAGAMENTO
// ========================
app.get('/api/payment/status/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)

    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    res.json({
      atendimentoId: at.id,
      pago: at.pagamento || false,
      status: at.status,
      criado_em: at.criado_em,
      pago_em: at.pago_em || null
    })

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📄 PÁGINAS DE RETORNO (SUCCESS / CANCEL)
// ========================
app.get('/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pagamento Confirmado - Doctor Prescreve</title>
    <style>
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .box {
            background: white;
            padding: 48px;
            border-radius: 24px;
            max-width: 500px;
            margin: 0 auto;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            animation: fadeIn 0.5s ease-in;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        h1 { color: #28a745; font-size: 48px; margin-bottom: 16px; }
        p { color: #666; font-size: 18px; line-height: 1.6; margin: 16px 0; }
        .checkmark { font-size: 80px; color: #28a745; margin-bottom: 20px; }
        a {
            background: #667eea; color: white; padding: 14px 32px;
            border-radius: 12px; text-decoration: none; display: inline-block;
            margin-top: 24px; font-weight: 600; transition: transform 0.2s;
        }
        a:hover { transform: translateY(-2px); background: #5a67d8; }
        .footer { margin-top: 32px; font-size: 12px; color: #999; }
    </style>
</head>
<body>
    <div class="box">
        <div class="checkmark">✅</div>
        <h1>Pagamento Confirmado!</h1>
        <p>Seu atendimento foi registrado com sucesso.</p>
        <p>📱 Você receberá um WhatsApp com o resultado da análise em até <strong>24 horas úteis</strong>.</p>
        <p>🔒 Transação segura via Stripe</p>
        <a href="/">🏠 Voltar para Home</a>
        <div class="footer"><p>Doctor Prescreve - Consulta Segura</p></div>
    </div>
</body>
</html>`)
})

app.get('/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pagamento Cancelado - Doctor Prescreve</title>
    <style>
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #eb3349 0%, #f45c43 100%);
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .box {
            background: white;
            padding: 48px;
            border-radius: 24px;
            max-width: 500px;
            margin: 0 auto;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            animation: fadeIn 0.5s ease-in;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        h1 { color: #dc3545; font-size: 48px; margin-bottom: 16px; }
        p { color: #666; font-size: 18px; line-height: 1.6; margin: 16px 0; }
        .cross { font-size: 80px; color: #dc3545; margin-bottom: 20px; }
        a {
            background: #667eea; color: white; padding: 14px 32px;
            border-radius: 12px; text-decoration: none; display: inline-block;
            margin-top: 24px; font-weight: 600; transition: transform 0.2s;
        }
        a:hover { transform: translateY(-2px); background: #5a67d8; }
    </style>
</head>
<body>
    <div class="box">
        <div class="cross">❌</div>
        <h1>Pagamento Cancelado</h1>
        <p>Você cancelou o processo de pagamento.</p>
        <p>💳 Pode tentar novamente quando estiver pronto.</p>
        <p>🔒 Seu atendimento está aguardando o pagamento.</p>
        <a href="/">🏠 Voltar para Home</a>
    </div>
</body>
</html>`)
})

// ========================
// 📋 ENDPOINTS DA FILA E PAINEL (PROTEGIDOS)
// ========================

// Listar todos os atendimentos
app.get('/api/atendimentos', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()

    const atendimentosFormatados = atendimentos.map(a => ({
      id: a.id,
      paciente_nome: safeDecrypt(a.paciente_nome),
      paciente_telefone: safeDecrypt(a.paciente_telefone),
      paciente_cpf: safeDecrypt(a.paciente_cpf),
      paciente_email: safeDecrypt(a.paciente_email),
      triagem: a.triagem,
      elegivel: a.elegivel,
      status: a.status,
      pagamento: a.pagamento,
      criado_em: a.criado_em
    }))

    atendimentosFormatados.sort((a, b) =>
      new Date(b.criado_em) - new Date(a.criado_em)
    )

    res.json(atendimentosFormatados)
  } catch (e) {
    console.error('❌ Erro ao listar atendimentos:', e.message)
    res.status(500).json({ error: 'Erro ao carregar atendimentos' })
  }
})

// Buscar atendimento específico
app.get('/api/atendimento/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)

    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    res.json({
      id: at.id,
      paciente_nome: safeDecrypt(at.paciente_nome),
      paciente_telefone: safeDecrypt(at.paciente_telefone),
      paciente_cpf: safeDecrypt(at.paciente_cpf),
      paciente_email: safeDecrypt(at.paciente_email),
      triagem: at.triagem,
      elegivel: at.elegivel,
      status: at.status,
      pagamento: at.pagamento,
      criado_em: at.criado_em
    })
  } catch (e) {
    console.error('❌ Erro ao buscar atendimento:', e.message)
    res.status(500).json({ error: 'Erro ao carregar atendimento' })
  }
})

// Listar apenas atendimentos na fila
app.get('/api/fila', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()

    const fila = atendimentos.filter(a =>
      a.pagamento === true && a.status === 'FILA'
    )

    const filaFormatada = fila.map(a => ({
      id: a.id,
      paciente_nome: safeDecrypt(a.paciente_nome),
      paciente_telefone: safeDecrypt(a.paciente_telefone),
      triagem: a.triagem,
      status: a.status,
      criado_em: a.criado_em
    }))

    filaFormatada.sort((a, b) =>
      new Date(a.criado_em) - new Date(b.criado_em)
    )

    res.json({
      total: filaFormatada.length,
      atendimentos: filaFormatada
    })
  } catch (e) {
    console.error('❌ Erro ao listar fila:', e.message)
    res.status(500).json({ error: 'Erro ao carregar fila' })
  }
})

// ========================
// 📊 ESTATÍSTICAS
// ========================
app.get('/api/estatisticas', auth, async (req, res) => {
  try {
    const stats = await db.getEstatisticas()
    res.json(stats)
  } catch (e) {
    console.error('❌ Erro ao buscar estatísticas:', e.message)
    res.status(500).json({ error: 'Erro ao carregar estatísticas' })
  }
})

// ========================
// 🔄 WEBHOOK PARA ATUALIZAR STATUS
// ========================
app.post('/api/webhook/atualizar-status', async (req, res) => {
  try {
    const { atendimentoId, status } = req.body

    if (!atendimentoId || !status) {
      return res.status(400).json({ error: 'atendimentoId e status são obrigatórios' })
    }

    await db.atualizarStatus(atendimentoId, status)

    res.json({ success: true, message: 'Status atualizado' })
  } catch (e) {
    console.error('❌ Erro no webhook de status:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 👨‍⚕️ DECISÃO MÉDICA
// ========================
app.post('/api/decisao/:id', auth, async (req, res) => {
  try {
    const { id } = req.params
    const { decisao, observacao, medicamento, posologia } = req.body

    if (!decisao || (decisao !== 'APROVAR' && decisao !== 'RECUSAR')) {
      return res.status(400).json({
        error: 'Decisão inválida. Use "APROVAR" ou "RECUSAR"'
      })
    }

    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    if (at.status === 'APROVADO' || at.status === 'RECUSADO') {
      return res.status(400).json({
        error: `Este atendimento já foi ${at.status === 'APROVADO' ? 'aprovado' : 'recusado'}`
      })
    }

    if (!at.pagamento) {
      return res.status(400).json({
        error: 'Pagamento não confirmado. Aguarde o pagamento do paciente.'
      })
    }

    const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
    await db.atualizarStatus(id, decisao)

    // Obter dados do tipo para gerar medicação
    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const decisaoData = {
      status: novoStatus,
      data: new Date().toISOString(),
      medico: req.usuario?.role || 'medico',
      observacao: observacao || (decisao === 'APROVAR' ? 'Aprovado conforme critérios clínicos' : 'Não atende aos critérios estabelecidos'),
      medicamento_prescrito: decisao === 'APROVAR' ? (medicamento || gerarMedicacao(tipo)) : null,
      posologia: posologia || (decisao === 'APROVAR' ? gerarPosologia(tipo) : null)
    }

    // Enviar notificação WhatsApp
    const telefone = safeDecrypt(at.paciente_telefone)
    const nome = safeDecrypt(at.paciente_nome)

    if (telefone) {
      let mensagemWhatsApp = ''

      if (decisao === 'APROVAR') {
        mensagemWhatsApp = `✅ *ÓTIMAS NOTÍCIAS, ${nome.toUpperCase()}!* ✅\n\n` +
          `Sua solicitação foi *APROVADA* pelo nosso corpo clínico.\n\n` +
          `📋 *Medicamento prescrito:* ${decisaoData.medicamento_prescrito}\n` +
          `💊 *Posologia:* ${decisaoData.posologia}\n\n` +
          `📄 Você receberá sua receita digital em breve.\n\n` +
          `👨‍⚕️ Doctor Prescreve - Cuidando de você!`
      } else {
        mensagemWhatsApp = `❌ *ATENÇÃO, ${nome.toUpperCase()}!* ❌\n\n` +
          `Sua solicitação foi *RECUSADA* pelo nosso corpo clínico.\n\n` +
          `📝 *Motivo:* ${observacao || 'Não atende aos critérios clínicos estabelecidos'}\n\n` +
          `👨‍⚕️ Doctor Prescreve - Sempre à disposição!`
      }

      await enviarWhatsAppOficial(telefone, mensagemWhatsApp)
    }

    // Gerar prontuário se aprovado
    let prontuario = null
    let receitaUrl = null
    if (decisao === 'APROVAR') {
      prontuario = {
        queixa: gerarQueixa(tipo),
        historia: gerarHistoria(tipo),
        exame_fisico: gerarExameFisico(tipo),
        conduta: gerarConduta(tipo),
        medicacao: decisaoData.medicamento_prescrito,
        posologia: decisaoData.posologia
      }
      receitaUrl = `${BASE_URL}/api/receita/${id}`
    }

    console.log(`📝 Decisão médica: ${novoStatus} - Atendimento: ${id} - Paciente: ${nome}`)

    res.json({
      success: true,
      atendimentoId: id,
      status: novoStatus,
      decisao: decisaoData,
      prontuario: prontuario,
      receitaUrl: receitaUrl,
      notificacao_enviada: !!telefone,
      mensagem: `Atendimento ${novoStatus.toLowerCase()} com sucesso`
    })

  } catch (e) {
    console.error('❌ Erro ao processar decisão:', e.message)
    res.status(500).json({
      error: 'Erro interno ao processar decisão médica',
      detalhe: e.message
    })
  }
})

// ========================
// 📋 HISTÓRICO DE DECISÕES
// ========================
app.get('/api/decisoes', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()

    const decisoes = atendimentos
      .filter(a => a.status === 'APROVADO' || a.status === 'RECUSADO')
      .map(a => ({
        id: a.id,
        paciente_nome: safeDecrypt(a.paciente_nome),
        status: a.status,
        triagem: a.triagem,
        criado_em: a.criado_em
      }))
      .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))

    res.json({
      total: decisoes.length,
      aprovados: decisoes.filter(d => d.status === 'APROVADO').length,
      recusados: decisoes.filter(d => d.status === 'RECUSADO').length,
      decisoes: decisoes
    })

  } catch (e) {
    console.error('❌ Erro ao buscar decisões:', e.message)
    res.status(500).json({ error: 'Erro ao carregar histórico' })
  }
})

// ========================
// 🔄 REVISÃO DE DECISÃO
// ========================
app.put('/api/decisao/:id/revisar', auth, async (req, res) => {
  try {
    const { id } = req.params
    const { novaDecisao, motivoRevisao, observacao } = req.body

    if (!novaDecisao || (novaDecisao !== 'APROVAR' && novaDecisao !== 'RECUSAR')) {
      return res.status(400).json({ error: 'Nova decisão inválida' })
    }

    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const statusAnterior = at.status
    await db.atualizarStatus(id, novaDecisao)
    const novoStatus = novaDecisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'

    // Notificar paciente sobre a revisão
    const telefone = safeDecrypt(at.paciente_telefone)
    if (telefone) {
      const mensagem = `🔄 *REVISÃO MÉDICA* 🔄\n\n` +
        `Sua solicitação foi revisada.\n` +
        `Status anterior: ${statusAnterior}\n` +
        `Novo status: ${novoStatus}\n\n` +
        `📝 Motivo: ${motivoRevisao || 'Reanálise do caso'}`

      await enviarWhatsAppOficial(telefone, mensagem)
    }

    res.json({
      success: true,
      atendimentoId: id,
      status_anterior: statusAnterior,
      status_novo: novoStatus,
      mensagem: `Decisão revisada com sucesso`
    })

  } catch (e) {
    console.error('❌ Erro ao revisar decisão:', e.message)
    res.status(500).json({ error: 'Erro ao revisar decisão' })
  }
})

// ========================
// 📊 ESTATÍSTICAS DAS DECISÕES
// ========================
app.get('/api/estatisticas/decisoes', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()

    const aprovados = atendimentos.filter(a => a.status === 'APROVADO')
    const recusados = atendimentos.filter(a => a.status === 'RECUSADO')

    res.json({
      total_decisoes: aprovados.length + recusados.length,
      aprovados: {
        total: aprovados.length,
        percentual: atendimentos.length > 0 ? (aprovados.length / atendimentos.length * 100).toFixed(2) : 0
      },
      recusados: {
        total: recusados.length,
        percentual: atendimentos.length > 0 ? (recusados.length / atendimentos.length * 100).toFixed(2) : 0
      }
    })

  } catch (e) {
    console.error('❌ Erro nas estatísticas de decisões:', e.message)
    res.status(500).json({ error: 'Erro ao carregar estatísticas' })
  }
})

// ========================
// 📋 PRONTUÁRIO
// ========================
app.get('/api/prontuario/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const dadosPaciente = {
      nome: safeDecrypt(at.paciente_nome),
      cpf: safeDecrypt(at.paciente_cpf),
      telefone: safeDecrypt(at.paciente_telefone),
      email: safeDecrypt(at.paciente_email)
    }

    const prontuario = {
      queixa: gerarQueixa(tipo, triagem),
      historia: gerarHistoria(tipo, triagem),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, triagem),
      medicacao: gerarMedicacao(tipo, triagem),
      posologia: gerarPosologia(tipo),
      recomendacoes: gerarRecomendacoes(tipo),
      score_risco: calcularScoreRisco(tipo, triagem),
      data_atendimento: new Date().toISOString(),
      validade_receita: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    }

    res.json({
      paciente: dadosPaciente,
      condicao: triagem,
      prontuario: prontuario,
      atendimento: {
        id: at.id,
        status: at.status,
        criado_em: at.criado_em
      }
    })

  } catch (e) {
    console.error('❌ Erro ao gerar prontuário:', e.message)
    res.status(500).json({ error: 'Erro ao gerar prontuário' })
  }
})

// Prontuário completo
app.get('/api/prontuario/:id/completo', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const prontuarioBase = {
      paciente: safeDecrypt(at.paciente_nome),
      queixa: gerarQueixa(tipo, triagem),
      historia: gerarHistoria(tipo, triagem),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, triagem),
      medicacao: gerarMedicacao(tipo, triagem),
      posologia: gerarPosologia(tipo)
    }

    res.json({
      ...prontuarioBase,
      prontuario_completo: true,
      gerado_em: new Date().toISOString()
    })

  } catch (e) {
    console.error('❌ Erro ao gerar prontuário completo:', e.message)
    res.status(500).json({ error: 'Erro ao gerar prontuário completo' })
  }
})

// Prontuário resumido (para WhatsApp)
app.get('/api/prontuario/:id/resumido', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const resumo = {
      paciente: safeDecrypt(at.paciente_nome),
      doenca: triagem.doenca || 'Não especificada',
      conduta_resumida: gerarConduta(tipo, triagem),
      medicacao: gerarMedicacao(tipo, triagem),
      proximo_retorno: "3 meses"
    }

    res.json(resumo)

  } catch (e) {
    console.error('❌ Erro ao gerar prontuário resumido:', e.message)
    res.status(500).json({ error: 'Erro ao gerar resumo' })
  }
})

// Prontuário PDF (HTML)
app.get('/api/prontuario/:id/pdf', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const prontuario = {
      paciente_nome: safeDecrypt(at.paciente_nome),
      paciente_cpf: safeDecrypt(at.paciente_cpf),
      queixa: gerarQueixa(tipo, triagem),
      historia: gerarHistoria(tipo, triagem),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, triagem),
      medicacao: gerarMedicacao(tipo, triagem),
      posologia: gerarPosologia(tipo),
      recomendacoes: gerarRecomendacoes(tipo)
    }

    const html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Prontuário - ${prontuario.paciente_nome}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { text-align: center; margin-bottom: 30px; }
        .title { color: #1a6b8a; }
        .section { margin-bottom: 20px; }
        .section-title { background: #f0f2f5; padding: 8px; font-weight: bold; }
        .content { padding: 10px; }
        .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1 class="title">Doctor Prescreve</h1>
        <h3>Prontuário Médico</h3>
        <p>Data: ${new Date().toLocaleDateString('pt-BR')}</p>
      </div>
      <div class="section">
        <div class="section-title">Dados do Paciente</div>
        <div class="content">
          <strong>Nome:</strong> ${prontuario.paciente_nome}<br>
          <strong>CPF:</strong> ${prontuario.paciente_cpf || 'Não informado'}
        </div>
      </div>
      <div class="section">
        <div class="section-title">Queixa Principal</div>
        <div class="content">${prontuario.queixa}</div>
      </div>
      <div class="section">
        <div class="section-title">História Clínica</div>
        <div class="content">${prontuario.historia}</div>
      </div>
      <div class="section">
        <div class="section-title">Exame Físico</div>
        <div class="content">${prontuario.exame_fisico}</div>
      </div>
      <div class="section">
        <div class="section-title">Conduta e Prescrição</div>
        <div class="content">
          <strong>Medicação:</strong> ${prontuario.medicacao}<br>
          <strong>Posologia:</strong> ${prontuario.posologia}<br>
          <strong>Conduta:</strong> ${prontuario.conduta}
        </div>
      </div>
      <div class="section">
        <div class="section-title">Recomendações</div>
        <div class="content">${prontuario.recomendacoes.replace(/\n/g, '<br>')}</div>
      </div>
      <div class="footer">
        <p>Documento gerado eletronicamente - Válido em todo território nacional</p>
        <p>Doctor Prescreve - Telemedicina com responsabilidade</p>
      </div>
    </body>
    </html>`

    res.setHeader('Content-Type', 'text/html')
    res.send(html)

  } catch (e) {
    console.error('❌ Erro ao gerar PDF:', e.message)
    res.status(500).json({ error: 'Erro ao gerar PDF do prontuário' })
  }
})

// Exportar prontuário JSON
app.get('/api/prontuario/:id/export', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const triagem = at.triagem || {}
    const tipo = triagem.tipo || detectarTipo(triagem.doenca || '')

    const exportData = {
      metadata: {
        id: at.id,
        exportado_em: new Date().toISOString(),
        versao: "2.0",
        sistema: "Doctor Prescreve"
      },
      paciente: {
        nome: safeDecrypt(at.paciente_nome),
        cpf: safeDecrypt(at.paciente_cpf),
        telefone: safeDecrypt(at.paciente_telefone),
        email: safeDecrypt(at.paciente_email)
      },
      clinico: {
        condicao: triagem.doenca,
        tipo: tipo,
        queixa: gerarQueixa(tipo, triagem),
        historia: gerarHistoria(tipo, triagem),
        exame_fisico: gerarExameFisico(tipo),
        conduta: gerarConduta(tipo, triagem),
        medicacao: gerarMedicacao(tipo, triagem),
        posologia: gerarPosologia(tipo),
        recomendacoes: gerarRecomendacoes(tipo),
        score_risco: calcularScoreRisco(tipo, triagem)
      },
      status: at.status,
      datas: {
        criacao: at.criado_em
      }
    }

    res.json(exportData)

  } catch (e) {
    console.error('❌ Erro ao exportar prontuário:', e.message)
    res.status(500).json({ error: 'Erro ao exportar prontuário' })
  }
})

// ========================
// 📄 RECEITA MÉDICA
// ========================

// Salvar receita
app.post('/api/receita', auth, async (req, res) => {
  try {
    const receita = req.body
    const id = receita.atendimentoId || receita.id || uuidv4()

    if (!receita.medicamento && !receita.medicamentos) {
      return res.status(400).json({
        error: 'Receita deve conter pelo menos um medicamento'
      })
    }

    const receitaCompleta = {
      id: id,
      numero: `REC-${id.substring(0, 8)}-${Date.now()}`,
      atendimentoId: id,
      paciente: receita.paciente || null,
      medicamentos: receita.medicamentos || [{
        nome: receita.medicamento,
        posologia: receita.posologia || 'Uso conforme orientação médica',
        quantidade: receita.quantidade || 30,
        duracao: receita.duracao || '30 dias'
      }],
      observacoes: receita.observacoes || '',
      medico: receita.medico || {
        nome: process.env.MEDICO_NOME ? `Dr. ${process.env.MEDICO_NOME} ${process.env.MEDICO_SOBRENOME || ''}`.trim() : 'Dr. Plantonista',
        registro: process.env.MEDICO_NUMERO ? `${process.env.MEDICO_CONSELHO || 'CRM'} ${process.env.MEDICO_NUMERO}` : 'CRM 12345',
        especialidade: 'Clínica Geral'
      },
      data_emissao: new Date().toISOString(),
      data_validade: new Date(Date.now() + (parseInt(process.env.RECEITA_VALIDADE_DIAS) || 90) * 24 * 60 * 60 * 1000).toISOString(),
      assinatura_digital: crypto
        .createHash('sha256')
        .update(id + process.env.JWT_SECRET + Date.now())
        .digest('hex'),
      status: 'ATIVA',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const filePath = path.join(DB_DIR, `receita_${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(receitaCompleta, null, 2))

    console.log(`✅ Receita salva: ${receitaCompleta.numero}`)

    res.json({
      success: true,
      receita: receitaCompleta,
      mensagem: 'Receita gerada com sucesso',
      links: {
        pdf: `${BASE_URL}/api/receita/${id}/pdf`,
        json: `${BASE_URL}/api/receita/${id}`,
        whatsapp: `${BASE_URL}/api/receita/${id}/enviar-whatsapp`
      }
    })

  } catch (e) {
    console.error('❌ Erro ao salvar receita:', e.message)
    res.status(500).json({ error: 'Erro ao gerar receita' })
  }
})

// Buscar receita
app.get('/api/receita/:id', auth, async (req, res) => {
  try {
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Receita não encontrada' })
    }

    const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    res.json(receita)

  } catch (e) {
    console.error('❌ Erro ao buscar receita:', e.message)
    res.status(500).json({ error: 'Erro ao carregar receita' })
  }
})

// Gerar PDF da receita
app.get('/api/receita/:id/pdf', auth, async (req, res) => {
  try {
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Receita não encontrada' })
    }

    const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const at = await db.buscarAtendimentoPorId(req.params.id)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename=receita_${receita.numero}.pdf`)

    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    doc.pipe(res)

    // Cabeçalho
    doc.fontSize(20)
      .fillColor('#1a6b8a')
      .text('DOCTOR PRESCREVE', { align: 'center' })
      .fontSize(12)
      .fillColor('#666')
      .text('Telemedicina com Responsabilidade', { align: 'center' })
      .moveDown()

    // Linha divisória
    doc.strokeColor('#1a6b8a')
      .lineWidth(1)
      .moveTo(50, doc.y)
      .lineTo(550, doc.y)
      .stroke()
      .moveDown()

    // Título
    doc.fontSize(16)
      .fillColor('#000')
      .text('RECEITA MÉDICA', { align: 'center' })
      .moveDown()

    // Informações da receita
    doc.fontSize(10)
      .text(`Número: ${receita.numero}`, { continued: true })
      .text(`                    Emissão: ${new Date(receita.data_emissao).toLocaleDateString('pt-BR')}`)
      .text(`Validade: ${new Date(receita.data_validade).toLocaleDateString('pt-BR')}`)
      .moveDown()

    // Dados do paciente
    doc.fontSize(12)
      .fillColor('#1a6b8a')
      .text('IDENTIFICAÇÃO DO PACIENTE', { underline: true })
      .moveDown(0.5)

    doc.fontSize(10)
      .fillColor('#000')
      .text(`Nome: ${receita.paciente?.nome || (at ? safeDecrypt(at.paciente_nome) : 'N/A')}`)
      .text(`CPF: ${receita.paciente?.cpf || (at ? safeDecrypt(at.paciente_cpf) : 'N/A')}`)
      .moveDown()

    // Medicamentos
    doc.fontSize(12)
      .fillColor('#1a6b8a')
      .text('MEDICAMENTOS PRESCRITOS', { underline: true })
      .moveDown(0.5)

    receita.medicamentos.forEach((med, index) => {
      doc.fontSize(10)
        .fillColor('#000')
        .text(`${index + 1}. ${med.nome.toUpperCase()}`)
        .text(`   Posologia: ${med.posologia}`)
        .text(`   Quantidade: ${med.quantidade} unidades`)
        .text(`   Duração: ${med.duracao}`)
        .moveDown(0.5)
    })

    // Observações
    if (receita.observacoes) {
      doc.moveDown()
        .fontSize(12)
        .fillColor('#1a6b8a')
        .text('OBSERVAÇÕES', { underline: true })
        .moveDown(0.5)
        .fontSize(10)
        .fillColor('#000')
        .text(receita.observacoes)
        .moveDown()
    }

    // Informações do médico
    doc.moveDown()
      .fontSize(12)
      .fillColor('#1a6b8a')
      .text('IDENTIFICAÇÃO DO MÉDICO', { underline: true })
      .moveDown(0.5)

    doc.fontSize(10)
      .fillColor('#000')
      .text(`Nome: ${receita.medico.nome}`)
      .text(`Registro: ${receita.medico.registro}`)
      .text(`Especialidade: ${receita.medico.especialidade}`)

    // Assinatura digital
    doc.moveDown()
      .fontSize(8)
      .fillColor('#999')
      .text(`Assinatura Digital: ${receita.assinatura_digital.substring(0, 20)}...`, { align: 'center' })

    // Gerar QR Code
    try {
      const qrData = JSON.stringify({
        numero: receita.numero,
        paciente: receita.paciente?.nome || (at ? safeDecrypt(at.paciente_nome) : 'N/A'),
        valido: true,
        url: `${BASE_URL}/api/receita/${req.params.id}/validar`
      })

      const qrCodeBuffer = await QRCode.toBuffer(qrData, { type: 'png', width: 100 })
      doc.image(qrCodeBuffer, 450, doc.y - 80, { width: 80 })
    } catch (qrErr) {
      console.warn('⚠️ Erro ao gerar QR Code:', qrErr.message)
    }

    // Rodapé
    doc.moveDown(3)
      .fontSize(8)
      .fillColor('#999')
      .text('Documento gerado eletronicamente - Válido em todo território nacional', { align: 'center' })
      .text('Lei 13.989/2020 - Telemedicina', { align: 'center' })

    doc.end()

  } catch (e) {
    console.error('❌ Erro ao gerar PDF:', e.message)
    res.status(500).json({ error: 'Erro ao gerar PDF da receita' })
  }
})

// Enviar receita por WhatsApp
app.post('/api/receita/:id/enviar-whatsapp', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const telefone = safeDecrypt(at.paciente_telefone)
    const nome = safeDecrypt(at.paciente_nome)

    if (!telefone) {
      return res.status(400).json({ error: 'Paciente sem telefone cadastrado' })
    }

    const pdfUrl = `${BASE_URL}/api/receita/${req.params.id}/pdf`
    const mensagem = `📄 *RECEITA MÉDICA* 📄\n\n` +
      `Olá ${nome},\n\n` +
      `Sua receita foi gerada com sucesso!\n\n` +
      `🔗 *Link da Receita:* ${pdfUrl}\n\n` +
      `📱 Apresente este documento em qualquer farmácia.\n\n` +
      `✅ *Validade:* 90 dias\n\n` +
      `👨‍⚕️ Doctor Prescreve - Cuidando de você!`

    await enviarWhatsAppOficial(telefone, mensagem)

    // Registrar envio
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)
    if (fs.existsSync(filePath)) {
      const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      receita.whatsapp_enviado = true
      receita.whatsapp_enviado_em = new Date().toISOString()
      fs.writeFileSync(filePath, JSON.stringify(receita, null, 2))
    }

    res.json({
      success: true,
      mensagem: 'Receita enviada por WhatsApp',
      telefone: telefone,
      enviado_em: new Date().toISOString()
    })

  } catch (e) {
    console.error('❌ Erro ao enviar receita:', e.message)
    res.status(500).json({ error: 'Erro ao enviar receita por WhatsApp' })
  }
})

// Validar receita (QR Code - público)
app.get('/api/receita/:id/validar', async (req, res) => {
  try {
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        valido: false,
        mensagem: 'Receita não encontrada'
      })
    }

    const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const dataValidade = new Date(receita.data_validade)
    const agora = new Date()

    const valida = dataValidade > agora && receita.status === 'ATIVA'

    res.json({
      valido: valida,
      numero: receita.numero,
      paciente: receita.paciente?.nome || 'N/A',
      emissao: receita.data_emissao,
      validade: receita.data_validade,
      status: valida ? 'VÁLIDA' : 'EXPIRADA',
      mensagem: valida ? 'Receita válida' : 'Receita expirada ou inválida'
    })

  } catch (e) {
    console.error('❌ Erro ao validar receita:', e.message)
    res.json({ valido: false, mensagem: 'Erro na validação' })
  }
})

// Listar receitas do paciente
app.get('/api/receitas/paciente/:atendimentoId', auth, async (req, res) => {
  try {
    const files = fs.readdirSync(DB_DIR)
    const receitasPaciente = []

    for (const file of files) {
      if (file.startsWith('receita_')) {
        const receita = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), 'utf8'))
        if (receita.atendimentoId === req.params.atendimentoId) {
          receitasPaciente.push(receita)
        }
      }
    }

    res.json({
      total: receitasPaciente.length,
      receitas: receitasPaciente.sort((a, b) =>
        new Date(b.data_emissao) - new Date(a.data_emissao)
      )
    })

  } catch (e) {
    console.error('❌ Erro ao listar receitas:', e.message)
    res.status(500).json({ error: 'Erro ao listar receitas' })
  }
})

// Cancelar receita
app.post('/api/receita/:id/cancelar', auth, async (req, res) => {
  try {
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Receita não encontrada' })
    }

    const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    receita.status = 'CANCELADA'
    receita.cancelada_em = new Date().toISOString()
    receita.motivo_cancelamento = req.body.motivo || 'Cancelada pelo médico'
    fs.writeFileSync(filePath, JSON.stringify(receita, null, 2))

    // Notificar paciente
    const at = await db.buscarAtendimentoPorId(receita.atendimentoId)
    if (at) {
      const telefone = safeDecrypt(at.paciente_telefone)
      if (telefone) {
        await enviarWhatsAppOficial(telefone,
          `⚠️ Sua receita foi cancelada.\nMotivo: ${receita.motivo_cancelamento}`
        )
      }
    }

    res.json({
      success: true,
      mensagem: 'Receita cancelada com sucesso',
      cancelada_em: receita.cancelada_em
    })

  } catch (e) {
    console.error('❌ Erro ao cancelar receita:', e.message)
    res.status(500).json({ error: 'Erro ao cancelar receita' })
  }
})

// Renovar receita
app.post('/api/receita/:id/renovar', auth, async (req, res) => {
  try {
    const filePathAntigo = path.join(DB_DIR, `receita_${req.params.id}.json`)

    if (!fs.existsSync(filePathAntigo)) {
      return res.status(404).json({ error: 'Receita original não encontrada' })
    }

    const receitaAntiga = JSON.parse(fs.readFileSync(filePathAntigo, 'utf8'))

    const novoId = uuidv4()
    const novaReceita = {
      ...receitaAntiga,
      id: novoId,
      numero: `REC-${novoId.substring(0, 8)}-${Date.now()}`,
      data_emissao: new Date().toISOString(),
      data_validade: new Date(Date.now() + (parseInt(process.env.RECEITA_VALIDADE_DIAS) || 90) * 24 * 60 * 60 * 1000).toISOString(),
      renovacao_de: receitaAntiga.numero,
      assinatura_digital: crypto
        .createHash('sha256')
        .update(novoId + process.env.JWT_SECRET + Date.now())
        .digest('hex'),
      status: 'ATIVA'
    }

    const novoFilePath = path.join(DB_DIR, `receita_${novoId}.json`)
    fs.writeFileSync(novoFilePath, JSON.stringify(novaReceita, null, 2))

    // Notificar paciente
    const at = await db.buscarAtendimentoPorId(receitaAntiga.atendimentoId)
    if (at) {
      const telefone = safeDecrypt(at.paciente_telefone)
      if (telefone) {
        await enviarWhatsAppOficial(telefone,
          `✅ Sua receita foi renovada!\nNova receita: ${BASE_URL}/api/receita/${novoId}/pdf`
        )
      }
    }

    res.json({
      success: true,
      mensagem: 'Receita renovada com sucesso',
      nova_receita: {
        id: novoId,
        numero: novaReceita.numero,
        pdf_url: `${BASE_URL}/api/receita/${novoId}/pdf`
      }
    })

  } catch (e) {
    console.error('❌ Erro ao renovar receita:', e.message)
    res.status(500).json({ error: 'Erro ao renovar receita' })
  }
})

// Webhook para receita (Memed)
app.post('/api/webhook/receita', auth, async (req, res) => {
  try {
    const { atendimentoId, pdfUrl, medicamentos, assinado } = req.body

    if (!atendimentoId || !pdfUrl) {
      return res.status(400).json({ error: 'Dados incompletos' })
    }

    const receita = {
      id: atendimentoId,
      atendimentoId: atendimentoId,
      pdfUrl: pdfUrl,
      medicamentos: medicamentos,
      assinado: assinado,
      data_emissao: new Date().toISOString(),
      origem: 'MEMED',
      status: 'ATIVA'
    }

    const filePath = path.join(DB_DIR, `receita_${atendimentoId}.json`)
    fs.writeFileSync(filePath, JSON.stringify(receita, null, 2))

    // Enviar para o paciente
    const at = await db.buscarAtendimentoPorId(atendimentoId)
    if (at && at.paciente_telefone) {
      const telefone = safeDecrypt(at.paciente_telefone)
      const nome = safeDecrypt(at.paciente_nome)

      await enviarWhatsAppOficial(telefone,
        `📄 Olá ${nome}, sua receita está pronta!\n\nLink: ${pdfUrl}\n\nVálida por 90 dias.`
      )
    }

    res.json({ success: true, mensagem: 'Receita processada via Memed' })

  } catch (e) {
    console.error('❌ Erro no webhook da receita:', e.message)
    res.status(500).json({ error: 'Erro ao processar webhook' })
  }
})

// ========================
// 📞 FILA DE SUPORTE
// ========================
app.post('/api/suporte/fila', async (req, res) => {
  try {
    const { telefone, nome } = req.body

    if (!telefone || !nome) {
      return res.status(400).json({ error: 'telefone e nome são obrigatórios' })
    }

    const registro = await db.adicionarFilaSuporte(telefone, nome)

    if (!registro) {
      return res.status(500).json({ error: 'Erro ao adicionar à fila' })
    }

    res.status(201).json({
      success: true,
      mensagem: 'Adicionado à fila de suporte',
      posicao: registro.id
    })
  } catch (e) {
    console.error('❌ Erro ao adicionar à fila de suporte:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/suporte/fila', auth, async (req, res) => {
  try {
    const fila = await db.getFilaSuporte()
    res.json({ total: fila.length, fila })
  } catch (e) {
    console.error('❌ Erro ao buscar fila de suporte:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/suporte/fila/:id/responder', auth, async (req, res) => {
  try {
    const registro = await db.responderFilaSuporte(req.params.id)

    if (!registro) {
      return res.status(404).json({ error: 'Registro não encontrado ou já respondido' })
    }

    res.json({ success: true, mensagem: 'Paciente respondido', registro })
  } catch (e) {
    console.error('❌ Erro ao responder fila de suporte:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🚀 INICIALIZAR SERVIDOR
// ========================
async function startServer() {
  try {
    // Inicializar banco de dados
    db.initDB()
    console.log('✅ Módulo de banco de dados inicializado')

    // Iniciar servidor
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server rodando na porta ${PORT}`)
      console.log(`🌐 BASE_URL: ${BASE_URL}`)
      console.log(`📦 Ambiente: ${process.env.NODE_ENV || 'development'}`)
      console.log(`📱 WhatsApp: modo ${WHATSAPP_MODE}`)
    })
  } catch (e) {
    console.error('❌ Erro ao iniciar servidor:', e.message)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM recebido. Encerrando...')
  await db.closeConnection()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT recebido. Encerrando...')
  await db.closeConnection()
  process.exit(0)
})

startServer()
