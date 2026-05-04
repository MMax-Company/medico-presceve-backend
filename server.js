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
const { createExpressMiddleware } = require('@trpc/server/adapters/express')
const { appRouter } = require('./dashboard-medico/server/routers')
const { createContext } = require('./dashboard-medico/server/_core/context')

// ========================
// 🚀 CONFIGURAÇÃO DO EXPRESS
// ========================
const app = express()
const PORT = process.env.PORT || 3002
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`

// ========================
// 🔒 ESTADOS VÁLIDOS DO FLUXO (Ponto 6)
// ========================
const ESTADOS_FLUXO = {
  TRIAGEM: 'TRIAGEM',
  INELEGIVEL: 'INELEGIVEL',
  AGUARDANDO_PAGAMENTO: 'AGUARDANDO_PAGAMENTO',
  FILA: 'FILA',
  APROVADO: 'APROVADO',
  RECUSADO: 'RECUSADO',
  RECEITA_EMITIDA: 'RECEITA_EMITIDA'
}

// Transições permitidas (de → para[])
const TRANSICOES_VALIDAS = {
  [ESTADOS_FLUXO.TRIAGEM]: [ESTADOS_FLUXO.AGUARDANDO_PAGAMENTO, ESTADOS_FLUXO.INELEGIVEL],
  [ESTADOS_FLUXO.AGUARDANDO_PAGAMENTO]: [ESTADOS_FLUXO.FILA],
  [ESTADOS_FLUXO.FILA]: [ESTADOS_FLUXO.APROVADO, ESTADOS_FLUXO.RECUSADO],
  [ESTADOS_FLUXO.APROVADO]: [ESTADOS_FLUXO.RECEITA_EMITIDA, ESTADOS_FLUXO.RECUSADO],
  [ESTADOS_FLUXO.RECUSADO]: [ESTADOS_FLUXO.APROVADO]
}

function transicaoValida(statusAtual, novoStatus) {
  const permitidos = TRANSICOES_VALIDAS[statusAtual]
  if (!permitidos) return false
  return permitidos.includes(novoStatus)
}

// ========================
// ⚠️ WEBHOOK STRIPE (deve vir ANTES do express.json global) - Ponto 11
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado. Pulando verificação.')
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

      // Ponto 11: Garantir pagamento = true → move pra FILA
      if (at.pagamento) {
        console.log(`⚠️ Pagamento já processado para: ${atendimentoId}`)
        return res.json({ received: true })
      }

      // Validar transição de status (Ponto 6)
      if (at.status !== ESTADOS_FLUXO.AGUARDANDO_PAGAMENTO) {
        console.error(`❌ Status inválido para pagamento: ${at.status}`)
        return res.json({ received: true })
      }

      await db.atualizarStatusPagamento(atendimentoId, true, ESTADOS_FLUXO.FILA)

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

// PRIORIDADE MÁXIMA: Servir arquivos estáticos do dashboard
const dashboardDistPath = path.join(__dirname, 'dashboard-medico', 'dist', 'public')
console.log('🔍 Tentando servir dashboard de:', dashboardDistPath)
if (fs.existsSync(dashboardDistPath)) {
  console.log('✅ Pasta dist encontrada!')
  app.use("/painel-medico", express.static(dashboardDistPath))
} else {
  console.log('❌ Pasta dist NÃO encontrada!')
}

app.use(express.json())


app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https://*"],
      connectSrc: ["'self'", "https://*"],
      workerSrc: ["'self'", "blob:"],
    },
  },
}))

// ========================
// 📱 FUNÇÃO WHATSAPP (MODO TESTE)
// ========================
const WHATSAPP_MODE = process.env.WHATSAPP_MODE || 'test'

async function enviarWhatsAppOficial(telefone, mensagem, tipo = 'notificacao') {
  console.log(`📡 [N8N] Enviando notificação para o n8n para o telefone: ${telefone}`)
  
  try {
    const axios = require('axios')
    const webhookUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL

    if (!webhookUrl) {
      console.warn('⚠️ N8N_WHATSAPP_WEBHOOK_URL não configurado. Mensagem não enviada.')
      console.log(`[LOG] Destino: ${telefone} | Mensagem: ${mensagem}`)
      return true
    }

    await axios.post(webhookUrl, {
      telefone,
      mensagem,
      tipo,
      timestamp: new Date().toISOString()
    })

    return true
  } catch (error) {
    console.error('❌ Erro ao notificar n8n:', error.message)
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
  if (!key) return text
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  if (!text) return ''
  const key = getEncryptionKey()
  if (!key) return text
  try {
    const [ivHex, data] = text.split(':')
    if (!ivHex || !data) return text
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch (e) {
    return text
  }
}

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
// 💾 DIRETÓRIO LOCAL PARA RECEITAS
// ========================
const DB_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

// ========================
// 🔒 VALIDAÇÃO DE INPUTS (Ponto 10)
// ========================
function validarCPF(cpf) {
  if (!cpf) return false
  cpf = cpf.replace(/[^\d]/g, '')
  if (cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false

  let soma = 0
  for (let i = 0; i < 9; i++) soma += parseInt(cpf.charAt(i)) * (10 - i)
  let resto = 11 - (soma % 11)
  if (resto === 10 || resto === 11) resto = 0
  if (resto !== parseInt(cpf.charAt(9))) return false

  soma = 0
  for (let i = 0; i < 10; i++) soma += parseInt(cpf.charAt(i)) * (11 - i)
  resto = 11 - (soma % 11)
  if (resto === 10 || resto === 11) resto = 0
  if (resto !== parseInt(cpf.charAt(10))) return false

  return true
}

function validarTelefone(telefone) {
  if (!telefone) return false
  const limpo = telefone.replace(/[^\d]/g, '')
  return limpo.length >= 10 && limpo.length <= 13
}

function validarInputTriagem(paciente, triagem) {
  const erros = []

  if (!paciente.nome || paciente.nome.trim().length < 3) {
    erros.push('Nome do paciente é obrigatório (mínimo 3 caracteres)')
  }

  if (!paciente.telefone || !validarTelefone(paciente.telefone)) {
    erros.push('Telefone inválido (deve ter 10-13 dígitos)')
  }

  if (paciente.cpf && !validarCPF(paciente.cpf)) {
    erros.push('CPF inválido')
  }

  if (!triagem.doencas) {
    erros.push('Campo triagem.doencas é obrigatório')
  }

  if (!triagem.medicacao_em_uso || triagem.medicacao_em_uso.trim().length === 0) {
    erros.push('Campo triagem.medicacao_em_uso é obrigatório')
  }

  if (!triagem.tempo_doenca || parseInt(triagem.tempo_doenca) < 30) {
    erros.push('Tempo de doença deve ser superior a 30 dias')
  }

  return erros
}

// ========================
// 🧠 MOTOR CLÍNICO (Ponto 8 - Padronizado, sem variação)
// ========================
function detectarTipo(texto) {
  if (!texto) return 'OUTRO'
  const lowerText = typeof texto === 'string' ? texto.toLowerCase() : String(texto).toLowerCase()

  if (lowerText.includes('hipert') || lowerText.includes('pressão') || lowerText.includes('pressao') || lowerText.includes('has')) return 'HAS'
  if (lowerText.includes('diabetes') || lowerText.includes('açucar') || lowerText.includes('acucar')) return 'DIABETES'
  if (lowerText.includes('tireo') || lowerText.includes('hipotireoidismo')) return 'HIPOTIREOIDISMO'
  if (lowerText.includes('colesterol') || lowerText.includes('dislipidemia')) return 'DISLIPIDEMIA'
  if (lowerText.includes('ansiedade') || lowerText.includes('depressão') || lowerText.includes('depressao')) return 'SAUDE_MENTAL'

  return 'OUTRO'
}

// Ponto 8: Prontuário padronizado - sem randomização, sempre igual
function gerarQueixa(tipo) {
  const base = {
    HAS: "Paciente em acompanhamento por hipertensão arterial sistêmica, solicita renovação de receita.",
    DIABETES: "Paciente em acompanhamento por diabetes mellitus tipo 2, solicita continuidade do tratamento.",
    HIPOTIREOIDISMO: "Paciente com hipotireoidismo em tratamento, solicita renovação de medicação.",
    DISLIPIDEMIA: "Paciente com dislipidemia em tratamento, solicita renovação de medicação.",
    SAUDE_MENTAL: "Paciente em acompanhamento por transtorno de ansiedade/depressão, solicita renovação.",
    OUTRO: "Paciente em acompanhamento clínico, solicita renovação de medicação de uso contínuo."
  }
  return base[tipo] || base.OUTRO
}

function gerarHistoria(tipo) {
  const historias = {
    HAS: "Paciente refere estabilidade do quadro pressórico. Nega cefaleia, tontura ou palpitações. Sem internações recentes. Adesão ao tratamento relatada.",
    DIABETES: "Paciente nega poliúria, polidipsia ou polifagia. Refere seguimento com nutricionista. Realiza monitorização glicêmica.",
    HIPOTIREOIDISMO: "Paciente nega ganho ponderal excessivo, astenia ou intolerância ao frio. Refere boa energia para atividades diárias.",
    DISLIPIDEMIA: "Paciente relata dieta hipolipídica. Nega eventos cardiovasculares prévios.",
    SAUDE_MENTAL: "Paciente relata melhora do humor e ansiedade com medicação atual. Nega ideação suicida.",
    OUTRO: "Paciente refere-se assintomático ao momento. Sem intercorrências desde último atendimento."
  }
  return historias[tipo] || historias.OUTRO
}

function gerarExameFisico(tipo) {
  const exames = {
    HAS: "PA: informada pelo paciente como controlada. FC: dentro da normalidade.",
    DIABETES: "Paciente eutrófico. Sem lesões de pele. Extremidades preservadas.",
    HIPOTIREOIDISMO: "Tireoide palpável sem nódulos. Sem bócio. Reflexos normais.",
    OUTRO: "Consulta remota - exame físico limitado. Sem queixas ativas."
  }
  return exames[tipo] || exames.OUTRO
}

function gerarConduta(tipo) {
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

function gerarRecomendacoes(tipo) {
  const recomendacoes = {
    HAS: "- Redução do sódio na dieta\n- Prática regular de exercícios\n- Evitar bebidas alcoólicas",
    DIABETES: "- Controle de carboidratos\n- Monitorização glicêmica\n- Atividade física regular",
    HIPOTIREOIDISMO: "- Tomar medicação em jejum\n- Aguardar 30 min para café da manhã\n- Evitar antiácidos próximo ao horário",
    OUTRO: "- Manter estilo de vida saudável\n- Hidratação adequada\n- Retorno conforme agendado"
  }
  return recomendacoes[tipo] || recomendacoes.OUTRO
}

// Helper: normalizar doencas (pode vir como string ou array)
function normalizarDoencas(doencas) {
  if (Array.isArray(doencas)) return doencas.join(', ').toLowerCase()
  if (typeof doencas === 'string') return doencas.toLowerCase()
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

// Rota raiz removida para dar prioridade ao Dashboard estático

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
// 🧠 TRIAGEM (Ponto 10: Validação de Input)
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    // Ponto 10: Validação completa de inputs
    const errosValidacao = validarInputTriagem(paciente, triagem)
    if (errosValidacao.length > 0) {
      return res.status(400).json({
        error: 'Dados inválidos',
        detalhes: errosValidacao
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

    // Ponto 3 + 12: Dados clínicos estruturados (visíveis no painel + preparação Memed)
    const dados_clinicos = {
      doenca: texto,
      tipo,
      medicacao_em_uso: triagem.medicacao_em_uso || null,
      posologia_atual: triagem.posologia_atual || null,
      tempo_doenca: triagem.tempo_doenca || null,
      receita_vencida_dias: triagem.receita_vencida_dias || null,
      ultima_consulta: triagem.ultima_consulta || null,
      comorbidades: triagem.comorbidades || null,
      alergias: triagem.alergias || null,
      elegivel_protocolo: elegivel,
      risco: "baixo"
    }

    const triagemData = {
      doenca: texto,
      tipo,
      risco: "baixo"
    }

    // Salvar no banco PostgreSQL
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
      dados_clinicos,
      elegivel,
      motivo: elegivel ? 'Condição elegível para renovação remota' : 'Condição não elegível para renovação remota',
      status: elegivel ? ESTADOS_FLUXO.AGUARDANDO_PAGAMENTO : ESTADOS_FLUXO.INELEGIVEL,
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

    // Ponto 6: Verificar se está no status correto para pagamento
    if (at.status !== ESTADOS_FLUXO.AGUARDANDO_PAGAMENTO) {
      return res.status(400).json({ error: `Status inválido para pagamento: ${at.status}` })
    }

    if (at.pagamento) {
      return res.status(400).json({ error: 'Pagamento já realizado' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: {
        atendimentoId: atendimentoId
      },
      line_items: [{
        price_data: {
          currency: process.env.CURRENCY || 'brl',
          product_data: {
            name: process.env.PRODUCT_NAME || 'Consulta Assíncrona - Doctor Prescreve',
            description: 'Renovação de receita médica com avaliação de médico licenciado'
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
        body { font-family: 'Segoe UI', Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
        .box { background: white; padding: 48px; border-radius: 24px; max-width: 500px; margin: 0 auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #28a745; font-size: 48px; margin-bottom: 16px; }
        p { color: #666; font-size: 18px; line-height: 1.6; margin: 16px 0; }
        .checkmark { font-size: 80px; color: #28a745; margin-bottom: 20px; }
        a { background: #667eea; color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; display: inline-block; margin-top: 24px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="box">
        <div class="checkmark">✅</div>
        <h1>Pagamento Confirmado!</h1>
        <p>Seu atendimento foi registrado com sucesso.</p>
        <p>📱 Você receberá um WhatsApp com o resultado em até <strong>24 horas úteis</strong>.</p>
        <p>🔒 Transação segura via Stripe</p>
        <a href="/">🏠 Voltar para Home</a>
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
        body { font-family: 'Segoe UI', Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #eb3349 0%, #f45c43 100%); min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
        .box { background: white; padding: 48px; border-radius: 24px; max-width: 500px; margin: 0 auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #dc3545; font-size: 48px; margin-bottom: 16px; }
        p { color: #666; font-size: 18px; line-height: 1.6; margin: 16px 0; }
        .cross { font-size: 80px; color: #dc3545; margin-bottom: 20px; }
        a { background: #667eea; color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; display: inline-block; margin-top: 24px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="box">
        <div class="cross">❌</div>
        <h1>Pagamento Cancelado</h1>
        <p>Você cancelou o processo de pagamento.</p>
        <p>💳 Pode tentar novamente quando estiver pronto.</p>
        <a href="/">🏠 Voltar para Home</a>
    </div>
</body>
</html>`)
})

// ========================
// 📋 FILA - SÓ PACIENTES VÁLIDOS (Ponto 2)
// ========================
app.get('/api/fila', auth, async (req, res) => {
  try {
    // Ponto 2: Usa query que filtra pagamento=true + elegivel=true + status=FILA
    const fila = await db.getFilaValida()

    // Ponto 3: Retorna dados clínicos visíveis no painel
    const filaFormatada = fila.map(a => {
      const dadosClinicos = a.dados_clinicos || a.triagem || {}
      return {
        id: a.id,
        paciente_nome: safeDecrypt(a.paciente_nome),
        paciente_telefone: safeDecrypt(a.paciente_telefone),
        // Ponto 3: Dados clínicos visíveis para o médico decidir
        doencas: dadosClinicos.doenca || dadosClinicos.condicao || 'N/A',
        medicacao_em_uso: dadosClinicos.medicacao_em_uso || 'N/A',
        tempo_doenca: dadosClinicos.tempo_doenca || 'N/A',
        receita_vencida_dias: dadosClinicos.receita_vencida_dias || 'N/A',
        tipo: dadosClinicos.tipo || 'OUTRO',
        elegivel_protocolo: dadosClinicos.elegivel_protocolo || false,
        status: a.status,
        criado_em: a.criado_em,
        pago_em: a.pago_em
      }
    })

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
// 📋 LISTAR TODOS OS ATENDIMENTOS (PAINEL)
// ========================
app.get('/api/atendimentos', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()

    const atendimentosFormatados = atendimentos.map(a => {
      const dadosClinicos = a.dados_clinicos || a.triagem || {}
      return {
        id: a.id,
        paciente_nome: safeDecrypt(a.paciente_nome),
        paciente_telefone: safeDecrypt(a.paciente_telefone),
        paciente_cpf: safeDecrypt(a.paciente_cpf),
        paciente_email: safeDecrypt(a.paciente_email),
        // Ponto 3: Dados clínicos no painel
        doencas: dadosClinicos.doenca || dadosClinicos.condicao || 'N/A',
        medicacao_em_uso: dadosClinicos.medicacao_em_uso || 'N/A',
        tempo_doenca: dadosClinicos.tempo_doenca || 'N/A',
        receita_vencida_dias: dadosClinicos.receita_vencida_dias || 'N/A',
        tipo: dadosClinicos.tipo || 'OUTRO',
        elegivel: a.elegivel,
        status: a.status,
        pagamento: a.pagamento,
        decisao: a.decisao,
        criado_em: a.criado_em,
        pago_em: a.pago_em
      }
    })

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

    const dadosClinicos = at.dados_clinicos || at.triagem || {}

      res.json({
      id: at.id,
      paciente_nome: safeDecrypt(at.paciente_nome),
      paciente_telefone: safeDecrypt(at.paciente_telefone),
      paciente_cpf: safeDecrypt(at.paciente_cpf),
      paciente_email: safeDecrypt(at.paciente_email),
      doencas: dadosClinicos.doenca || dadosClinicos.condicao || 'N/A',
      medicacao_em_uso: dadosClinicos.medicacao_em_uso || 'N/A',
      tempo_doenca: dadosClinicos.tempo_doenca || 'N/A',
      receita_vencida_dias: dadosClinicos.receita_vencida_dias || 'N/A',
      tipo: dadosClinicos.tipo || 'OUTRO',
      elegivel: at.elegivel,
      elegivel_protocolo: dadosClinicos.elegivel_protocolo || false,
      status: at.status,
      pagamento: at.pagamento,
      decisao: at.decisao,
      criado_em: at.criado_em,
      pago_em: at.pago_em
    })
  } catch (e) {
    console.error('❌ Erro ao buscar atendimento:', e.message)
    res.status(500).json({ error: 'Erro ao carregar atendimento' })
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
//  PAINEL MEDICO
// ========================
app.get('/painel-medico', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Doctor Prescreve - Painel Médico Premium</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: #f8fafc;
      min-height: 100vh;
      color: #1e293b;
    }

    /* Login Container */
    .login-wrapper {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    }

    .login-card {
      background: rgba(255, 255, 255, 0.98);
      border-radius: 32px;
      padding: 48px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(10px);
      animation: fadeInUp 0.6s ease;
    }

    .login-header {
      text-align: center;
      margin-bottom: 32px;
    }

    .login-icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }

    .login-icon i {
      font-size: 40px;
      color: white;
    }

    .login-card h2 {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }

    .login-card p {
      color: #64748b;
      font-size: 14px;
    }

    .input-group {
      margin-bottom: 24px;
    }

    .input-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: #475569;
      font-size: 14px;
    }

    .input-group input {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e2e8f0;
      border-radius: 16px;
      font-size: 14px;
      transition: all 0.3s ease;
      font-family: 'Inter', sans-serif;
    }

    .input-group input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .login-btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      color: white;
      border: none;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .login-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.4);
    }

    /* Dashboard Container */
    .dashboard-container {
      display: none;
      padding: 24px;
      max-width: 1600px;
      margin: 0 auto;
    }

    /* Header Premium */
    .premium-header {
      background: white;
      border-radius: 24px;
      padding: 24px 32px;
      margin-bottom: 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      border: 1px solid #f1f5f9;
    }

    .logo-area h1 {
      font-size: 24px;
      font-weight: 800;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-area p {
      color: #64748b;
      font-size: 13px;
      margin-top: 4px;
      font-weight: 500;
    }

    .logout-btn {
      background: #fee2e2;
      color: #ef4444;
      border: none;
      padding: 10px 24px;
      border-radius: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logout-btn:hover {
      background: #fecaca;
      transform: translateY(-2px);
    }

    /* Stats Grid Premium */
    .stats-premium {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }

    .stat-card-premium {
      background: white;
      border-radius: 24px;
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: all 0.3s ease;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      border: 1px solid #f1f5f9;
    }

    .stat-card-premium:hover {
      transform: translateY(-4px);
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
    }

    .stat-info h3 {
      font-size: 32px;
      font-weight: 800;
      color: #0f172a;
    }

    .stat-info p {
      color: #64748b;
      font-size: 14px;
      margin-top: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-icon {
      width: 64px;
      height: 64px;
      background: #f1f5f9;
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .stat-icon i {
      font-size: 28px;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    /* Suporte Section */
    .suporte-section {
      background: white;
      border-radius: 24px;
      padding: 28px;
      margin-bottom: 32px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      border: 1px solid #f1f5f9;
    }

    .suporte-section h3 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #0f172a;
    }

    #suportesPendentes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
    }

    .suporte-card {
      background: #f8fafc;
      border-radius: 20px;
      padding: 20px;
      border-left: 6px solid #f59e0b;
      transition: all 0.3s ease;
    }

    .suporte-card:hover {
      transform: translateX(5px);
      background: #f1f5f9;
    }

    .suporte-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .suporte-nome { font-weight: 700; color: #1e293b; }
    .suporte-telefone { font-size: 13px; color: #64748b; background: #e2e8f0; padding: 4px 10px; border-radius: 8px; }
    .suporte-mensagem { background: white; padding: 12px; border-radius: 12px; margin: 12px 0; font-size: 14px; line-height: 1.5; color: #475569; border: 1px solid #e2e8f0; }
    .suporte-tempo { font-size: 12px; color: #94a3b8; font-weight: 500; }

    /* Columns Layout */
    .columns-container {
      display: flex;
      gap: 24px;
      overflow-x: auto;
      padding-bottom: 20px;
    }

    .column {
      flex: 1;
      min-width: 380px;
      background: #f1f5f9;
      border-radius: 28px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .column-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 10px;
      border-bottom: 2px solid #e2e8f0;
    }

    .column-header h3 {
      font-size: 16px;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .badge-count {
      background: #cbd5e1;
      color: #475569;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 700;
    }

    /* Patient Cards */
    .patient-card-premium {
      background: white;
      border-radius: 20px;
      padding: 20px;
      transition: all 0.3s ease;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      border: 1px solid transparent;
    }

    .patient-card-premium:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 20px -6px rgba(0, 0, 0, 0.1);
      border-color: #e2e8f0;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 16px;
    }

    .patient-name {
      font-size: 17px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 4px;
    }

    .patient-id {
      font-size: 11px;
      color: #94a3b8;
      font-family: 'JetBrains Mono', monospace;
    }

    .status-badge {
      padding: 6px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .status-fila { background: #fef3c7; color: #92400e; }
    .status-atendimento { background: #dbeafe; color: #1e40af; }
    .status-decisao { background: #dcfce7; color: #166534; }

    .patient-info {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 16px;
    }

    .info-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: #64748b;
    }

    .info-item i {
      width: 18px;
      color: #3b82f6;
    }

    .card-actions {
      display: flex;
      gap: 10px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #f1f5f9;
    }

    .btn-premium {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 12px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-success { background: #10b981; color: white; }
    .btn-success:hover { background: #059669; }
    .btn-danger { background: #ef4444; color: white; }
    .btn-danger:hover { background: #dc2626; }
    .btn-warning { background: #f59e0b; color: white; }
    .btn-warning:hover { background: #d97706; }

    /* Modal Premium */
    .modal-premium {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(8px);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }

    .modal-content {
      background: white;
      border-radius: 32px;
      max-width: 650px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: modalSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }

    @keyframes modalSlideUp {
      from { opacity: 0; transform: translateY(40px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .modal-header {
      padding: 24px 32px;
      border-bottom: 1px solid #f1f5f9;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      background: white;
      z-index: 10;
    }

    .modal-header h3 {
      font-size: 20px;
      font-weight: 800;
      color: #0f172a;
    }

    .close-modal {
      background: #f1f5f9;
      border: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #64748b;
      transition: all 0.2s;
    }

    .close-modal:hover { background: #e2e8f0; color: #0f172a; }

    .modal-body { padding: 32px; }

    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }

    .form-group { margin-bottom: 24px; }
    .form-group.full { grid-column: span 2; }

    .form-group label {
      display: block;
      margin-bottom: 10px;
      font-weight: 600;
      color: #475569;
      font-size: 14px;
    }

    .form-group input, .form-group textarea {
      width: 100%;
      padding: 14px;
      border: 2px solid #f1f5f9;
      border-radius: 16px;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      background: #f8fafc;
      transition: all 0.3s;
    }

    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: #3b82f6;
      background: white;
    }

    .form-group textarea { min-height: 120px; resize: vertical; }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #94a3b8;
    }

    .empty-state i { font-size: 48px; margin-bottom: 16px; display: block; }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 1024px) {
      .columns-container { flex-direction: column; }
      .column { min-width: 100%; }
      .form-grid { grid-template-columns: 1fr; }
      .form-group.full { grid-column: span 1; }
    }
  </style>
</head>
<body>

<!-- Login Screen -->
<div id="loginScreen" class="login-wrapper">
  <div class="login-card">
    <div class="login-header">
      <div class="login-icon">
        <i class="fas fa-stethoscope"></i>
      </div>
      <h2>Doctor Prescreve</h2>
      <p>Painel de Controle Médico</p>
    </div>
    <form id="loginForm">
      <div class="input-group">
        <label><i class="fas fa-lock"></i> Senha de Acesso</label>
        <input type="password" id="senha" placeholder="Digite sua senha">
      </div>
      <button type="submit" class="login-btn" id="loginBtn">
        <i class="fas fa-sign-in-alt"></i> Entrar no Painel
      </button>
    </form>
    <div id="erroMsg" style="color: #ef4444; text-align: center; margin-top: 16px; display: none; font-size: 14px; font-weight: 600;">
      ❌ Senha incorreta!
    </div>
  </div>
</div>

<!-- Dashboard -->
<div id="dashboard" class="dashboard-container">
  <div class="premium-header">
    <div class="logo-area">
      <h1><i class="fas fa-shield-halved"></i> Doctor Prescreve</h1>
      <p>Sistema de Telemedicina & Gestão Clínica</p>
    </div>
    <button class="logout-btn" id="logoutBtn">
      <i class="fas fa-power-off"></i> Sair do Sistema
    </button>
  </div>

  <div class="stats-premium" id="stats">
    <!-- Stats cards loaded via JS -->
  </div>

  <div class="suporte-section">
    <h3><i class="fas fa-headset" style="color: #f59e0b;"></i> CHAMADOS DE SUPORTE</h3>
    <div id="suportesPendentes">Carregando chamados...</div>
  </div>

  <div class="columns-container">
    <div class="column">
      <div class="column-header">
        <h3><i class="fas fa-clock"></i> Fila de Espera</h3>
        <span class="badge-count" id="countFila">0</span>
      </div>
      <div id="filaColuna"></div>
    </div>
    <div class="column">
      <div class="column-header">
        <h3><i class="fas fa-user-md"></i> Em Atendimento</h3>
        <span class="badge-count" id="countAtendimento">0</span>
      </div>
      <div id="atendimentoColuna"></div>
    </div>
    <div class="column">
      <div class="column-header">
        <h3><i class="fas fa-check-double"></i> Pronto para Decisão</h3>
        <span class="badge-count" id="countDecisao">0</span>
      </div>
      <div id="decisaoColuna"></div>
    </div>
  </div>
</div>

<!-- Modal -->
<div id="modal" class="modal-premium">
  <div class="modal-content">
    <div class="modal-header">
      <h3><i class="fas fa-file-medical"></i> Avaliação Médica</h3>
      <button class="close-modal" id="closeModalBtn">&times;</button>
    </div>
    <div class="modal-body">
      <div id="modalContent"></div>
      <div id="modalActions" style="margin-top: 32px; display: flex; gap: 16px;">
         <!-- Actions added dynamically -->
      </div>
    </div>
  </div>
</div>

<script>
  let token = localStorage.getItem('token');
  let atendimentosData = [];

  // Initialize Event Listeners
  document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        fazerLogin();
      });
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', logout);
    }

    const closeModalBtn = document.getElementById('closeModalBtn');
    if (closeModalBtn) {
      closeModalBtn.addEventListener('click', fecharModal);
    }

    if (token) {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      carregarDados();
    }
  });

  async function fazerLogin() {
    const senha = document.getElementById('senha').value;
    const erroMsg = document.getElementById('erroMsg');
    try {
      const res = await fetch(window.location.origin + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha })
      });
      const data = await res.json();
      if (data.token) {
        token = data.token;
        localStorage.setItem('token', token);
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        carregarDados();
        erroMsg.style.display = 'none';
      } else {
        erroMsg.style.display = 'block';
      }
    } catch(e) {
      erroMsg.style.display = 'block';
    }
  }

  function logout() {
    localStorage.removeItem('token');
    token = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('senha').value = '';
  }

  async function carregarDados() {
    if (!token) return;
    try {
      const res = await fetch(window.location.origin + '/api/atendimentos', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      atendimentosData = await res.json();
      
      const statsRes = await fetch(window.location.origin + '/api/estatisticas', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const stats = await statsRes.json();
      
      atualizarEstatisticas(stats);
      renderizarColunas();
      carregarSuportes();
    } catch(e) {
      console.error('Erro ao carregar:', e);
    }
  }

  function atualizarEstatisticas(stats) {
    const statsHtml = \`
      <div class="stat-card-premium">
        <div class="stat-info"><h3>\${stats.total || 0}</h3><p>Total Geral</p></div>
        <div class="stat-icon"><i class="fas fa-folder-open"></i></div>
      </div>
      <div class="stat-card-premium">
        <div class="stat-info"><h3>\${stats.naFila || 0}</h3><p>Aguardando</p></div>
        <div class="stat-icon"><i class="fas fa-hourglass-half"></i></div>
      </div>
      <div class="stat-card-premium">
        <div class="stat-info"><h3>\${stats.aprovados || 0}</h3><p>Aprovados</p></div>
        <div class="stat-icon"><i class="fas fa-check-circle"></i></div>
      </div>
      <div class="stat-card-premium">
        <div class="stat-info"><h3>\${stats.recusados || 0}</h3><p>Recusados</p></div>
        <div class="stat-icon"><i class="fas fa-times-circle"></i></div>
      </div>
    \`;
    document.getElementById('stats').innerHTML = statsHtml;
  }

  async function carregarSuportes() {
    try {
      const res = await fetch('/api/suporte/pendentes');
      const suportes = await res.json();
      let html = '';
      
      if (suportes.length === 0) {
        html = '<div class="empty-state" style="grid-column: 1/-1;"><i class="fas fa-check-circle"></i><p>Nenhum chamado pendente</p></div>';
      } else {
        suportes.forEach(s => {
          html += \`
            <div class="suporte-card">
              <div class="suporte-header">
                <span class="suporte-nome">👤 \${s.nome || 'Paciente'}</span>
                <span class="suporte-telefone">\${s.telefone}</span>
              </div>
              <div class="suporte-mensagem">\${s.mensagem || 'Aguardando atendimento'}</div>
              <div class="suporte-tempo"><i class="far fa-clock"></i> Há \${formatarTempo(s.criado_em)}</div>
              <div style="margin-top: 15px;">
                <button class="btn-premium btn-warning btn-atender-suporte" data-id="\${s.id}" data-tel="\${s.telefone}" data-nome="\${s.nome || 'Paciente'}">
                  <i class="fas fa-reply"></i> Atender Chamado
                </button>
              </div>
            </div>
          \`;
        });
      }
      document.getElementById('suportesPendentes').innerHTML = html;
      
      // Attach events to support buttons
      document.querySelectorAll('.btn-atender-suporte').forEach(btn => {
        btn.addEventListener('click', function() {
          atenderSuporte(this.dataset.id, this.dataset.tel, this.dataset.nome);
        });
      });
    } catch(e) {
      console.error(e);
    }
  }

  function formatarTempo(dataCriacao) {
    if (!dataCriacao) return 'agora';
    const criado = new Date(dataCriacao);
    const agora = new Date();
    const diffMin = Math.floor((agora - criado) / 60000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return diffMin + ' min';
    return Math.floor(diffMin / 60) + 'h';
  }

  async function atenderSuporte(id, telefone, nome) {
    if (!confirm('Atender ' + nome + '? O paciente será notificado.')) return;
    try {
      await fetch('/api/suporte/atender/' + id, { method: 'POST' });
      await fetch('/api/enviar-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefone: telefone,
          mensagem: '👨‍⚕️ *Doctor Prescreve*\\\\n\\\\nOlá! Um atendente já está analisando seu caso e falará com você em breve.'
        })
      });
      alert('✅ Paciente notificado!');
      carregarSuportes();
    } catch(e) {
      alert('Erro: ' + e.message);
    }
  }

  function renderizarColunas() {
    const fila = atendimentosData.filter(a => a.status === 'FILA' && a.pagamento);
    const emAtendimento = atendimentosData.filter(a => a.status === 'EM_ATENDIMENTO');
    const prontoDecisao = atendimentosData.filter(a => a.status === 'PRONTO_PARA_DECISAO');

    document.getElementById('countFila').innerText = fila.length;
    document.getElementById('countAtendimento').innerText = emAtendimento.length;
    document.getElementById('countDecisao').innerText = prontoDecisao.length;

    renderizarColuna('filaColuna', fila, 'fila');
    renderizarColuna('atendimentoColuna', emAtendimento, 'atendimento');
    renderizarColuna('decisaoColuna', prontoDecisao, 'decisao');
  }

  function renderizarColuna(elementId, lista, tipo) {
    const container = document.getElementById(elementId);
    if (lista.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>Vazio</p></div>';
      return;
    }

    let html = '';
    lista.forEach(a => {
      let statusClass = 'status-' + tipo;
      let statusText = tipo === 'fila' ? '⏳ Na Fila' : tipo === 'atendimento' ? '👨‍⚕️ Atendendo' : '📝 Decisão';
      
      html += \`
        <div class="patient-card-premium">
          <div class="card-header">
            <div>
              <div class="patient-name">\${a.paciente_nome || 'Nome não informado'}</div>
              <div class="patient-id">ID: \${a.id.substring(0, 12)}...</div>
            </div>
            <span class="status-badge \${statusClass}">\${statusText}</span>
          </div>
          <div class="patient-info">
            <div class="info-item"><i class="fas fa-phone"></i> \${a.paciente_telefone || 'Não informado'}</div>
             <div class="info-item"><i class="fas fa-notes-medical"></i> ${a.doencas || a.doenca || 'Não informada'}</div>
            <div class="info-item"><i class="fas fa-calendar-alt"></i> \${new Date(a.criado_em).toLocaleDateString()}</div>
          </div>
          <div class="card-actions">
      \`;

      if (tipo === 'fila') {
        html += \`<button class="btn-premium btn-warning btn-pegar-proximo"><i class="fas fa-hand-holding-medical"></i> Pegar Próximo</button>\`;
      } else if (tipo === 'atendimento') {
        html += \`<button class="btn-premium btn-primary btn-abrir-prontuario" data-id="\${a.id}"><i class="fas fa-file-alt"></i> Prontuário</button>\`;
      } else {
        html += \`
          <button class="btn-premium btn-success btn-ver-decisao" data-id="\${a.id}"><i class="fas fa-check"></i> Aprovar</button>
          <button class="btn-premium btn-danger btn-recusar-consulta" data-id="\${a.id}"><i class="fas fa-times"></i> Recusar</button>
        \`;
      }

      html += \`</div></div>\`;
    });
    container.innerHTML = html;
    
    // Attach events to dynamic buttons
    container.querySelectorAll('.btn-pegar-proximo').forEach(btn => btn.addEventListener('click', pegarProximo));
    container.querySelectorAll('.btn-abrir-prontuario').forEach(btn => btn.addEventListener('click', function() { abrirProntuario(this.dataset.id); }));
    container.querySelectorAll('.btn-ver-decisao').forEach(btn => btn.addEventListener('click', function() { verDecisao(this.dataset.id); }));
    container.querySelectorAll('.btn-recusar-consulta').forEach(btn => btn.addEventListener('click', function() { recusarConsulta(this.dataset.id); }));
  }

  async function pegarProximo() {
    try {
      const res = await fetch('/api/fila/pegar-proximo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ medicoId: 'medico_' + Date.now() })
      });
      const data = await res.json();
      if (data.sucesso) {
        window.location.href = '/prontuario/' + data.atendimento.id;
      } else {
        alert('Fila vazia ou caso já em atendimento');
        carregarDados();
      }
    } catch(e) { alert('Erro: ' + e.message); }
  }

  function abrirProntuario(id) {
    window.location.href = '/prontuario/' + id;
  }

  async function verDecisao(id) {
    try {
      const res = await fetch(window.location.origin + '/api/atendimento/' + id, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const a = await res.json();

      const modal = document.getElementById('modal');
      const modalContent = document.getElementById('modalContent');
      const modalActions = document.getElementById('modalActions');
      
      modalContent.innerHTML = \`
        <div class="form-grid">
          <div class="form-group">
            <label><i class="fas fa-user"></i> Paciente</label>
            <input type="text" value="\${a.paciente_nome || ''}" disabled>
          </div>
          <div class="form-group">
            <label><i class="fas fa-phone"></i> Telefone</label>
            <input type="text" value="\${a.paciente_telefone || ''}" disabled>
          </div>
        </div>
        <div class="form-group">
          <label><i class="fas fa-notes-medical"></i> Doença/Queixa</label>
          <textarea disabled>${a.doencas || a.doenca || 'Não informado'}</textarea>
        </div>
        <div class="form-group">
          <label><i class="fas fa-capsules"></i> Medicamento Recomendado</label>
          <input type="text" id="medicamento" value="\${a.medicacao_em_uso || ''}" placeholder="Ex: Losartana 50mg">
        </div>
        <div class="form-group">
          <label><i class="fas fa-prescription-bottle"></i> Posologia</label>
          <textarea id="posologia" placeholder="Ex: 1 comprimido ao dia, pela manhã"></textarea>
        </div>
        <div class="form-group">
          <label><i class="fas fa-stethoscope"></i> Conduta Médica (Orientação)</label>
          <textarea id="conduta" placeholder="Orientação que o paciente receberá..."></textarea>
        </div>
      \`;

      modalActions.innerHTML = \`
        <button class="btn-premium btn-success" id="confirmAprovarBtn" style="padding: 14px;">
          <i class="fas fa-check-circle"></i> CONFIRMAR E ENVIAR RECEITA
        </button>
      \`;
      
      document.getElementById('confirmAprovarBtn').addEventListener('click', () => {
        aprovarConsulta(a.id);
      });
      
      modal.style.display = 'flex';
    } catch(e) { alert('Erro ao carregar prontuário'); }
  }

  async function aprovarConsulta(id) {
    const medicamento = document.getElementById('medicamento')?.value || '';
    const posologia = document.getElementById('posologia')?.value || '';
    const conduta = document.getElementById('conduta')?.value || '';
    
    if (!confirm('Confirmar aprovação? O paciente receberá a receita.')) return;
    
    try {
      const res = await fetch(window.location.origin + '/api/decisao/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          decisao: 'APROVAR',
          orientacoes: conduta,
          medicamento: medicamento,
          posologia: posologia
        })
      });
      
      if (res.ok) {
        alert('✅ Consulta aprovada com sucesso!');
        fecharModal();
        carregarDados();
      } else { alert('Erro ao aprovar consulta'); }
    } catch(e) { alert('Erro ao aprovar consulta'); }
  }

  async function recusarConsulta(id) {
    const motivo = prompt('Motivo da recusa (opcional):');
    if (!confirm('❌ Tem certeza que deseja recusar este atendimento?')) return;
    
    try {
      const res = await fetch(window.location.origin + '/api/decisao/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ decisao: 'RECUSAR', orientacoes: motivo || 'Recusado pelo médico' })
      });
      
      if (res.ok) {
        alert('❌ Consulta recusada');
        carregarDados();
      } else { alert('Erro ao recusar consulta'); }
    } catch(e) { alert('Erro ao recusar consulta'); }
  }

  function fecharModal() {
    document.getElementById('modal').style.display = 'none';
  }

  setInterval(() => {
    if (document.getElementById('dashboard').style.display === 'block') {
      carregarDados();
    }
  }, 30000);
</script>

</body>
</html>
  `)
})



// ========================
// 📜 HISTÓRICO DE DECISÕES (Ponto 7)
// ========================
app.get('/api/decisoes', auth, async (req, res) => {
  try {
    const logs = await db.getDecisoesLog()

    res.json({
      total: logs.length,
      aprovados: logs.filter(l => l.decisao === 'APROVAR').length,
      recusados: logs.filter(l => l.decisao === 'RECUSAR').length,
      decisoes: logs
    })
  } catch (e) {
    console.error('❌ Erro ao buscar decisões:', e.message)
    res.status(500).json({ error: 'Erro ao carregar histórico' })
  }
})

// Log de decisões de um atendimento específico
app.get('/api/decisoes/:atendimentoId', auth, async (req, res) => {
  try {
    const logs = await db.getDecisoesLog(req.params.atendimentoId)
    res.json({ total: logs.length, decisoes: logs })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🔄 REVISÃO DE DECISÃO MÉDICA
// ========================
app.put('/api/decisao/:id/revisar', auth, async (req, res) => {
  try {
    const { id } = req.params
    const { novaDecisao, motivoRevisao, observacao, medicamento, posologia } = req.body

    if (!novaDecisao || (novaDecisao !== 'APROVAR' && novaDecisao !== 'RECUSAR')) {
      return res.status(400).json({ error: 'Nova decisão inválida. Use "APROVAR" ou "RECUSAR"' })
    }

    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    // Só pode revisar decisões já tomadas (APROVADO ou RECUSADO)
    if (at.status !== ESTADOS_FLUXO.APROVADO && at.status !== ESTADOS_FLUXO.RECUSADO) {
      return res.status(400).json({
        error: `Só é possível revisar atendimentos com status APROVADO ou RECUSADO. Status atual: ${at.status}`
      })
    }

    const dadosClinicos = at.dados_clinicos || at.triagem || {}
    const statusAnterior = at.status
    const novoStatus = novaDecisao === 'APROVAR' ? ESTADOS_FLUXO.APROVADO : ESTADOS_FLUXO.RECUSADO

    // Se aprovando, exigir medicamento real (Ponto 4)
    if (novaDecisao === 'APROVAR') {
      const medicamentoFinal = medicamento || dadosClinicos.medicacao_em_uso
      if (!medicamentoFinal || medicamentoFinal.trim().length === 0) {
        return res.status(400).json({
          error: 'Medicação obrigatória para aprovação na revisão.'
        })
      }

      const posologiaFinal = posologia || dadosClinicos.posologia_atual || 'Uso contínuo conforme orientação médica'

      const decisaoData = {
        status: novoStatus,
        data: new Date().toISOString(),
        medico: req.usuario?.role || 'medico',
        observacao: observacao || `Revisão: ${motivoRevisao || 'Reanálise do caso'}`,
        medicamento_prescrito: medicamentoFinal,
        posologia: posologiaFinal
      }

      await db.atualizarStatus(id, 'APROVAR', decisaoData)

      // Log de revisão (Ponto 7)
      await db.salvarDecisaoLog({
        atendimento_id: id,
        medico: req.usuario?.role || 'medico',
        decisao: 'REVISAO_APROVAR',
        medicamento: medicamentoFinal,
        posologia: posologiaFinal,
        observacao: `Revisão de ${statusAnterior} para APROVADO. Motivo: ${motivoRevisao || 'Reanálise'}`,
        dados_clinicos: dadosClinicos
      })
    } else {
      const decisaoData = {
        status: novoStatus,
        data: new Date().toISOString(),
        medico: req.usuario?.role || 'medico',
        observacao: observacao || `Revisão: ${motivoRevisao || 'Reanálise do caso'}`
      }

      await db.atualizarStatus(id, 'RECUSAR', decisaoData)

      // Log de revisão (Ponto 7)
      await db.salvarDecisaoLog({
        atendimento_id: id,
        medico: req.usuario?.role || 'medico',
        decisao: 'REVISAO_RECUSAR',
        medicamento: null,
        posologia: null,
        observacao: `Revisão de ${statusAnterior} para RECUSADO. Motivo: ${motivoRevisao || 'Reanálise'}`,
        dados_clinicos: dadosClinicos
      })
    }

    // Notificar paciente sobre a revisão
    const telefone = safeDecrypt(at.paciente_telefone)
    const nome = safeDecrypt(at.paciente_nome)
    if (telefone) {
      const mensagem = `🔄 *REVISÃO MÉDICA* 🔄\n\n` +
        `Olá ${nome}, sua solicitação foi revisada.\n` +
        `Status anterior: ${statusAnterior}\n` +
        `Novo status: ${novoStatus}\n\n` +
        `📝 Motivo: ${motivoRevisao || 'Reanálise do caso'}\n\n` +
        `👨‍⚕️ Doctor Prescreve`
      await enviarWhatsAppOficial(telefone, mensagem)
    }

    res.json({
      success: true,
      atendimentoId: id,
      status_anterior: statusAnterior,
      status_novo: novoStatus,
      mensagem: 'Decisão revisada com sucesso',
      notificacao_enviada: !!telefone
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
    const logs = await db.getDecisoesLog()
    const aprovados = logs.filter(l => l.decisao === 'APROVAR')
    const recusados = logs.filter(l => l.decisao === 'RECUSAR')

    res.json({
      total_decisoes: logs.length,
      aprovados: {
        total: aprovados.length,
        percentual: logs.length > 0 ? (aprovados.length / logs.length * 100).toFixed(2) : 0
      },
      recusados: {
        total: recusados.length,
        percentual: logs.length > 0 ? (recusados.length / logs.length * 100).toFixed(2) : 0
      }
    })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao carregar estatísticas' })
  }
})

// ========================
// 📋 PRONTUÁRIO (Ponto 8: Padronizado)
// ========================
app.get('/api/prontuario/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const dadosClinicos = at.dados_clinicos || at.triagem || {}
    const tipo = dadosClinicos.tipo || detectarTipo(dadosClinicos.doenca || '')
    const decisao = at.decisao || {}

    const dadosPaciente = {
      nome: safeDecrypt(at.paciente_nome),
      cpf: safeDecrypt(at.paciente_cpf),
      telefone: safeDecrypt(at.paciente_telefone),
      email: safeDecrypt(at.paciente_email)
    }

    // Ponto 5 + 8: Usa dado real do paciente, padronizado
    const prontuario = {
      queixa: gerarQueixa(tipo),
      historia: gerarHistoria(tipo),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo),
      medicacao: decisao.medicamento_prescrito || dadosClinicos.medicacao_em_uso || 'Não definida',
      posologia: decisao.posologia || dadosClinicos.posologia_atual || 'Não definida',
      recomendacoes: gerarRecomendacoes(tipo),
      data_atendimento: new Date().toISOString(),
      validade_receita: new Date(Date.now() + (parseInt(process.env.RECEITA_VALIDADE_DIAS) || 90) * 24 * 60 * 60 * 1000).toISOString()
    }

    res.json({
      paciente: dadosPaciente,
      dados_clinicos: dadosClinicos,
      prontuario: prontuario,
      decisao_medica: decisao,
      atendimento: {
        id: at.id,
        status: at.status,
        criado_em: at.criado_em,
        pago_em: at.pago_em
      }
    })
  } catch (e) {
    console.error('❌ Erro ao gerar prontuário:', e.message)
    res.status(500).json({ error: 'Erro ao gerar prontuário' })
  }
})

// Prontuário resumido
app.get('/api/prontuario/:id/resumido', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const dadosClinicos = at.dados_clinicos || at.triagem || {}
    const decisao = at.decisao || {}

    res.json({
      paciente: safeDecrypt(at.paciente_nome),
      doenca: dadosClinicos.doenca || 'Não especificada',
      medicacao: decisao.medicamento_prescrito || dadosClinicos.medicacao_em_uso || 'Não definida',
      posologia: decisao.posologia || dadosClinicos.posologia_atual || 'Não definida',
      conduta_resumida: gerarConduta(dadosClinicos.tipo || 'OUTRO'),
      proximo_retorno: "3 meses"
    })
  } catch (e) {
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

    const dadosClinicos = at.dados_clinicos || at.triagem || {}
    const tipo = dadosClinicos.tipo || detectarTipo(dadosClinicos.doenca || '')
    const decisao = at.decisao || {}

    const prontuario = {
      paciente_nome: safeDecrypt(at.paciente_nome),
      paciente_cpf: safeDecrypt(at.paciente_cpf),
      queixa: gerarQueixa(tipo),
      historia: gerarHistoria(tipo),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo),
      medicacao: decisao.medicamento_prescrito || dadosClinicos.medicacao_em_uso || 'Não definida',
      posologia: decisao.posologia || dadosClinicos.posologia_atual || 'Não definida',
      recomendacoes: gerarRecomendacoes(tipo)
    }

    const html = `<!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Prontuário - ${prontuario.paciente_nome}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; }
      .header { text-align: center; margin-bottom: 30px; }
      .title { color: #1a6b8a; }
      .section { margin-bottom: 20px; }
      .section-title { background: #f0f2f5; padding: 8px; font-weight: bold; }
      .content { padding: 10px; }
      .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #666; }
    </style></head><body>
      <div class="header"><h1 class="title">Doctor Prescreve</h1><h3>Prontuário Médico</h3><p>Data: ${new Date().toLocaleDateString('pt-BR')}</p></div>
      <div class="section"><div class="section-title">Dados do Paciente</div><div class="content"><strong>Nome:</strong> ${prontuario.paciente_nome}<br><strong>CPF:</strong> ${prontuario.paciente_cpf || 'Não informado'}</div></div>
      <div class="section"><div class="section-title">Queixa Principal</div><div class="content">${prontuario.queixa}</div></div>
      <div class="section"><div class="section-title">História Clínica</div><div class="content">${prontuario.historia}</div></div>
      <div class="section"><div class="section-title">Exame Físico</div><div class="content">${prontuario.exame_fisico}</div></div>
      <div class="section"><div class="section-title">Conduta e Prescrição</div><div class="content"><strong>Medicação:</strong> ${prontuario.medicacao}<br><strong>Posologia:</strong> ${prontuario.posologia}<br><strong>Conduta:</strong> ${prontuario.conduta}</div></div>
      <div class="section"><div class="section-title">Recomendações</div><div class="content">${prontuario.recomendacoes.replace(/\n/g, '<br>')}</div></div>
      <div class="footer"><p>Documento gerado eletronicamente - Válido em todo território nacional</p><p>Doctor Prescreve - Telemedicina com responsabilidade</p></div>
    </body></html>`

    res.setHeader('Content-Type', 'text/html')
    res.send(html)
  } catch (e) {
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

    const dadosClinicos = at.dados_clinicos || at.triagem || {}
    const tipo = dadosClinicos.tipo || detectarTipo(dadosClinicos.doenca || '')
    const decisao = at.decisao || {}

    res.json({
      metadata: { id: at.id, exportado_em: new Date().toISOString(), versao: "3.0", sistema: "Doctor Prescreve" },
      paciente: {
        nome: safeDecrypt(at.paciente_nome),
        cpf: safeDecrypt(at.paciente_cpf),
        telefone: safeDecrypt(at.paciente_telefone),
        email: safeDecrypt(at.paciente_email)
      },
      clinico: {
        condicao: dadosClinicos.doenca,
        tipo: tipo,
        medicacao_em_uso: dadosClinicos.medicacao_em_uso,
        queixa: gerarQueixa(tipo),
        historia: gerarHistoria(tipo),
        exame_fisico: gerarExameFisico(tipo),
        conduta: gerarConduta(tipo),
        medicacao_prescrita: decisao.medicamento_prescrito || dadosClinicos.medicacao_em_uso,
        posologia: decisao.posologia || dadosClinicos.posologia_atual,
        recomendacoes: gerarRecomendacoes(tipo)
      },
      decisao_medica: decisao,
      status: at.status,
      datas: { criacao: at.criado_em, pagamento: at.pago_em }
    })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao exportar prontuário' })
  }
})

// ========================
// 📄 RECEITA MÉDICA (Ponto 5: Usando dado real)
// ========================
app.post('/api/receita', auth, async (req, res) => {
  try {
    const receita = req.body
    const id = receita.atendimentoId || receita.id || uuidv4()

    // Buscar atendimento para usar dados reais
    const at = await db.buscarAtendimentoPorId(id)
    const dadosClinicos = at?.dados_clinicos || at?.triagem || {}
    const decisao = at?.decisao || {}

    // Ponto 4+5: Medicação DEVE vir do dado real ou da decisão médica
    const medicamentoFinal = receita.medicamento || decisao.medicamento_prescrito || dadosClinicos.medicacao_em_uso
    if (!medicamentoFinal) {
      return res.status(400).json({
        error: 'Medicação não encontrada. Não é possível emitir receita sem medicamento definido.'
      })
    }

    const receitaCompleta = {
      id: id,
      numero: `REC-${id.substring(0, 8)}-${Date.now()}`,
      atendimentoId: id,
      paciente: receita.paciente || (at ? {
        nome: safeDecrypt(at.paciente_nome),
        cpf: safeDecrypt(at.paciente_cpf)
      } : null),
      medicamentos: receita.medicamentos || [{
        nome: medicamentoFinal,
        posologia: receita.posologia || decisao.posologia || dadosClinicos.posologia_atual || 'Uso conforme orientação médica',
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
      created_at: new Date().toISOString()
    }

    const filePath = path.join(DB_DIR, `receita_${id}.json`)
    await db.salvarReceita(receitaCompleta)

    // Atualizar status para RECEITA_EMITIDA (Ponto 6)
    if (at && at.status === ESTADOS_FLUXO.APROVADO) {
      await db.atualizarStatus(id, ESTADOS_FLUXO.RECEITA_EMITIDA)
    }

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
    const receita = await db.buscarReceitaPorId(req.params.id)
    if (!receita) {
      return res.status(404).json({ valido: false, mensagem: 'Receita não encontrada' })
    }
    res.json(receita)
  } catch (e) {
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

    doc.fontSize(20).fillColor('#1a6b8a').text('DOCTOR PRESCREVE', { align: 'center' })
      .fontSize(12).fillColor('#666').text('Telemedicina com Responsabilidade', { align: 'center' }).moveDown()

    doc.strokeColor('#1a6b8a').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown()

    doc.fontSize(16).fillColor('#000').text('RECEITA MÉDICA', { align: 'center' }).moveDown()

    doc.fontSize(10)
      .text(`Número: ${receita.numero}`, { continued: true })
      .text(`                    Emissão: ${new Date(receita.data_emissao).toLocaleDateString('pt-BR')}`)
      .text(`Validade: ${new Date(receita.data_validade).toLocaleDateString('pt-BR')}`)
      .moveDown()

    doc.fontSize(12).fillColor('#1a6b8a').text('IDENTIFICAÇÃO DO PACIENTE', { underline: true }).moveDown(0.5)
    doc.fontSize(10).fillColor('#000')
      .text(`Nome: ${receita.paciente?.nome || (at ? safeDecrypt(at.paciente_nome) : 'N/A')}`)
      .text(`CPF: ${receita.paciente?.cpf || (at ? safeDecrypt(at.paciente_cpf) : 'N/A')}`)
      .moveDown()

    doc.fontSize(12).fillColor('#1a6b8a').text('MEDICAMENTOS PRESCRITOS', { underline: true }).moveDown(0.5)

    receita.medicamentos.forEach((med, index) => {
      doc.fontSize(10).fillColor('#000')
        .text(`${index + 1}. ${med.nome.toUpperCase()}`)
        .text(`   Posologia: ${med.posologia}`)
        .text(`   Quantidade: ${med.quantidade} unidades`)
        .text(`   Duração: ${med.duracao}`)
        .moveDown(0.5)
    })

    if (receita.observacoes) {
      doc.moveDown().fontSize(12).fillColor('#1a6b8a').text('OBSERVAÇÕES', { underline: true }).moveDown(0.5)
        .fontSize(10).fillColor('#000').text(receita.observacoes).moveDown()
    }

    doc.moveDown().fontSize(12).fillColor('#1a6b8a').text('IDENTIFICAÇÃO DO MÉDICO', { underline: true }).moveDown(0.5)
    doc.fontSize(10).fillColor('#000')
      .text(`Nome: ${receita.medico.nome}`)
      .text(`Registro: ${receita.medico.registro}`)
      .text(`Especialidade: ${receita.medico.especialidade}`)

    doc.moveDown().fontSize(8).fillColor('#999')
      .text(`Assinatura Digital: ${receita.assinatura_digital.substring(0, 20)}...`, { align: 'center' })

    try {
      const qrData = JSON.stringify({ numero: receita.numero, valido: true, url: `${BASE_URL}/api/receita/${req.params.id}/validar` })
      const qrCodeBuffer = await QRCode.toBuffer(qrData, { type: 'png', width: 100 })
      doc.image(qrCodeBuffer, 450, doc.y - 80, { width: 80 })
    } catch (qrErr) {
      console.warn('⚠️ Erro ao gerar QR Code:', qrErr.message)
    }

    doc.moveDown(3).fontSize(8).fillColor('#999')
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
    if (!at) return res.status(404).json({ error: 'Atendimento não encontrado' })

    const telefone = safeDecrypt(at.paciente_telefone)
    const nome = safeDecrypt(at.paciente_nome)
    if (!telefone) return res.status(400).json({ error: 'Paciente sem telefone cadastrado' })

    const pdfUrl = `${BASE_URL}/api/receita/${req.params.id}/pdf`
    const mensagem = `📄 *RECEITA MÉDICA* 📄\n\nOlá ${nome},\n\nSua receita foi gerada com sucesso!\n\n🔗 *Link:* ${pdfUrl}\n\n📱 Apresente em qualquer farmácia.\n✅ *Validade:* 90 dias\n\n👨‍⚕️ Doctor Prescreve`

    await enviarWhatsAppOficial(telefone, mensagem)

    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)
    if (fs.existsSync(filePath)) {
      const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      receita.whatsapp_enviado = true
      receita.whatsapp_enviado_em = new Date().toISOString()
      fs.writeFileSync(filePath, JSON.stringify(receita, null, 2))
    }

    res.json({ success: true, mensagem: 'Receita enviada por WhatsApp', enviado_em: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao enviar receita por WhatsApp' })
  }
})

// Validar receita (público - QR Code)
app.get('/api/receita/:id/validar', async (req, res) => {
  try {
    const filePath = path.join(DB_DIR, `receita_${req.params.id}.json`)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ valido: false, mensagem: 'Receita não encontrada' })
    }

    const receita = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const valida = new Date(receita.data_validade) > new Date() && receita.status === 'ATIVA'

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
    res.json({ valido: false, mensagem: 'Erro na validação' })
  }
})

// Listar receitas do paciente
app.get('/api/receitas/paciente/:atendimentoId', auth, async (req, res) => {
  try {
    const receitasPaciente = await db.listarReceitasPorAtendimento(req.params.atendimentoId)
    res.json({
      total: receitasPaciente.length,
      receitas: receitasPaciente
    })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar receitas' })
  }
})

// Cancelar receita
app.post('/api/receita/:id/cancelar', auth, async (req, res) => {
  try {
    const receita = await db.buscarReceitaPorId(req.params.id)
    if (!receita) return res.status(404).json({ error: 'Receita não encontrada' })
    
    const motivo = req.body.motivo || 'Cancelada pelo médico'
    await db.atualizarStatusReceita(req.params.id, 'CANCELADA', motivo)

    const at = await db.buscarAtendimentoPorId(receita.atendimentoId)
    if (at) {
      const telefone = safeDecrypt(at.paciente_telefone)
      if (telefone) await enviarWhatsAppOficial(telefone, `⚠️ Sua receita foi cancelada.\nMotivo: ${receita.motivo_cancelamento}`)
    }

    res.json({ success: true, mensagem: 'Receita cancelada com sucesso' })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao cancelar receita' })
  }
})

// Renovar receita
app.post('/api/receita/:id/renovar', auth, async (req, res) => {
  try {
    const receitaAntiga = await db.buscarReceitaPorId(req.params.id)
    if (!receitaAntiga) return res.status(404).json({ error: 'Receita original não encontrada' })
    
    const novoId = uuidv4()
    const novaReceita = {
      ...receitaAntiga,
      id: novoId,
      numero: `REC-${novoId.substring(0, 8)}-${Date.now()}`,
      data_emissao: new Date().toISOString(),
      data_validade: new Date(Date.now() + (parseInt(process.env.RECEITA_VALIDADE_DIAS) || 90) * 24 * 60 * 60 * 1000).toISOString(),
      renovacao_de: receitaAntiga.numero,
      assinatura_digital: crypto.createHash('sha256').update(novoId + process.env.JWT_SECRET + Date.now()).digest('hex'),
      status: 'ATIVA'
    }
    await db.salvarReceita(novaReceita)

    const at = await db.buscarAtendimentoPorId(receitaAntiga.atendimentoId)
    if (at) {
      const telefone = safeDecrypt(at.paciente_telefone)
      if (telefone) await enviarWhatsAppOficial(telefone, `✅ Sua receita foi renovada!\nNova receita: ${BASE_URL}/api/receita/${novoId}/pdf`)
    }

    res.json({ success: true, mensagem: 'Receita renovada', nova_receita: { id: novoId, numero: novaReceita.numero, pdf_url: `${BASE_URL}/api/receita/${novoId}/pdf` } })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao renovar receita' })
  }
})

// Webhook receita (Memed)
app.post('/api/webhook/receita', auth, async (req, res) => {
  try {
    const { atendimentoId, pdfUrl, medicamentos, assinado } = req.body
    if (!atendimentoId || !pdfUrl) return res.status(400).json({ error: 'Dados incompletos' })

    const receita = {
      id: atendimentoId,
      atendimentoId,
      pdfUrl,
      medicamentos,
      assinado,
      data_emissao: new Date().toISOString(),
      origem: 'MEMED',
      status: 'ATIVA'
    }
    await db.salvarReceita(receita)

    const at = await db.buscarAtendimentoPorId(atendimentoId)
    if (at && at.paciente_telefone) {
      const telefone = safeDecrypt(at.paciente_telefone)
      const nome = safeDecrypt(at.paciente_nome)
      await enviarWhatsAppOficial(telefone, `📄 Olá ${nome}, sua receita está pronta!\n\nLink: ${pdfUrl}\n\nVálida por 90 dias.`)
    }

    res.json({ success: true, mensagem: 'Receita processada via Memed' })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao processar webhook' })
  }
})

// ========================
// 📞 FILA DE SUPORTE
// ========================
app.post('/api/suporte/fila', async (req, res) => {
  try {
    const { telefone, nome } = req.body
    if (!telefone || !nome) return res.status(400).json({ error: 'telefone e nome são obrigatórios' })

    const registro = await db.adicionarFilaSuporte(telefone, nome)
    if (!registro) return res.status(500).json({ error: 'Erro ao adicionar à fila' })

    res.status(201).json({ success: true, mensagem: 'Adicionado à fila de suporte', posicao: registro.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/suporte/fila', auth, async (req, res) => {
  try {
    const fila = await db.getFilaSuporte()
    res.json({ total: fila.length, fila })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/suporte/fila/:id/responder', auth, async (req, res) => {
  try {
    const registro = await db.responderFilaSuporte(req.params.id)
    if (!registro) return res.status(404).json({ error: 'Registro não encontrado ou já respondido' })
    res.json({ success: true, mensagem: 'Paciente respondido', registro })
  } catch (e) {
    res.status(500).json({ error: e.message })
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

    // Ponto 6: Validar transição
    const at = await db.buscarAtendimentoPorId(atendimentoId)
    if (!at) return res.status(404).json({ error: 'Atendimento não encontrado' })

    if (!transicaoValida(at.status, status)) {
      return res.status(400).json({
        error: `Transição inválida: ${at.status} → ${status}`,
        transicoes_permitidas: TRANSICOES_VALIDAS[at.status] || []
      })
    }

    await db.atualizarStatus(atendimentoId, status)
    res.json({ success: true, message: 'Status atualizado' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🚀 INICIALIZAR SERVIDOR
// ========================
async function startServer() {
  try {
    db.initDB()
    console.log('✅ Módulo de banco de dados inicializado')

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server rodando na porta ${PORT}`)
      console.log(`🌐 BASE_URL: ${BASE_URL}`)
      console.log(`📦 Ambiente: ${process.env.NODE_ENV || 'development'}`)
      console.log(`📱 WhatsApp: modo ${WHATSAPP_MODE}`)
      console.log(`🔒 Fluxo de estados: TRIAGEM → AGUARDANDO_PAGAMENTO → FILA → APROVADO/RECUSADO → RECEITA_EMITIDA`)
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

// Rota catch-all para o Dashboard (Single Page Application)
// Deve vir DEPOIS de todas as rotas da API
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dashboard-medico', 'dist', 'public', 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(404).json({ error: 'Dashboard não encontrado. Verifique se o build foi concluído.' })
  }
})

startServer()
