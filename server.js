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
// 💳 PAGAMENTO (STRIPE COMPLETO)
// ========================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy')

// ========================
// 1. ENDPOINT DE PAGAMENTO
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try {
    const atendimentoId = req.params.id
    
    // Verificar se o atendimento existe
    const at = await db.buscarAtendimentoPorId(atendimentoId)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    // Criar sessão de checkout no Stripe
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'pix'],
      metadata: { 
        atendimentoId: atendimentoId 
      },
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: {
            name: 'Consulta Assíncrona - Doctor Prescreve',
            description: 'Renovação de receita médica com avaliação de médico licenciado',
            images: ['https://images.unsplash.com/photo-1576091160550-112173f7f869?w=500']
          },
          unit_amount: 6990 // R$ 69,90
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
    
  } catch(e) {
    console.error('❌ Erro ao criar sessão Stripe:', e.message)
    res.status(500).json({ error: 'Erro ao gerar pagamento: ' + e.message })
  }
})

// ========================
// 2. WEBHOOK DO STRIPE
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  // Se não tiver webhook secret configurado, apenas confirma recebimento
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado. Pulando verificação.')
    return res.json({ received: true })
  }

  try {
    // Verificar assinatura do webhook
    const event = stripe.webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET
    )

    console.log(`📡 Webhook recebido: ${event.type}`)

    // Processar evento de checkout completo
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const atendimentoId = session.metadata?.atendimentoId

      if (!atendimentoId) {
        console.error('❌ Webhook: atendimentoId não encontrado na metadata')
        return res.json({ received: true })
      }

      console.log(`💰 Pagamento confirmado para atendimento: ${atendimentoId}`)

      // Buscar atendimento
      const at = await db.buscarAtendimentoPorId(atendimentoId)
      
      if (!at) {
        console.error(`❌ Atendimento não encontrado: ${atendimentoId}`)
        return res.json({ received: true })
      }

      // Verificar se já foi processado
      if (at.pagamento) {
        console.log(`⚠️ Pagamento já processado para: ${atendimentoId}`)
        return res.json({ received: true })
      }

      // Atualizar status do pagamento
      await db.atualizarStatusPagamento(atendimentoId, true, 'FILA')

      // Enviar WhatsApp confirmando pagamento
      const telefone = decrypt(at.paciente_telefone)
      const nome = decrypt(at.paciente_nome)

      if (telefone) {
        const msg = `✅ Pagamento confirmado, ${nome}!\n\n` +
                   `👨‍⚕️ Seu atendimento #${atendimentoId.substring(0, 8)} entrou na fila.\n\n` +
                   `⏳ Você receberá a resposta em até 24h úteis.\n\n` +
                   `🔗 Acompanhe: ${BASE_URL}/painel-medico`
        
        await enviarWhatsAppOficial(telefone, msg)
      }

      console.log(`✅ Pagamento processado com sucesso para: ${nome} (${atendimentoId})`)
    }

    // Evento de pagamento falhou
    if (event.type === 'checkout.session.expired') {
      const session = event.data.object
      const atendimentoId = session.metadata?.atendimentoId
      
      if (atendimentoId) {
        console.log(`⏰ Sessão expirada para atendimento: ${atendimentoId}`)
        await db.atualizarStatus(atendimentoId, 'PAGAMENTO_EXPIRADO')
      }
    }

    res.json({ received: true })
    
  } catch(e) {
    console.error('❌ Erro no webhook do Stripe:', e.message)
    res.status(400).send(`Webhook Error: ${e.message}`)
  }
})

// ========================
// 3. PÁGINAS DE RETORNO
// ========================

// Página de sucesso após pagamento
app.get('/success', (req, res) => {
  const sessionId = req.query.session_id
  
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
        h1 { 
            color: #28a745;
            font-size: 48px;
            margin-bottom: 16px;
        }
        p { 
            color: #666;
            font-size: 18px;
            line-height: 1.6;
            margin: 16px 0;
        }
        .checkmark {
            font-size: 80px;
            color: #28a745;
            margin-bottom: 20px;
        }
        a {
            background: #667eea;
            color: white;
            padding: 14px 32px;
            border-radius: 12px;
            text-decoration: none;
            display: inline-block;
            margin-top: 24px;
            font-weight: 600;
            transition: transform 0.2s;
        }
        a:hover {
            transform: translateY(-2px);
            background: #5a67d8;
        }
        .footer {
            margin-top: 32px;
            font-size: 12px;
            color: #999;
        }
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
        <div class="footer">
            <p>Doctor Prescreve - Consulta Segura</p>
        </div>
    </div>
</body>
</html>`)
})

// Página de cancelamento
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
        h1 { 
            color: #dc3545;
            font-size: 48px;
            margin-bottom: 16px;
        }
        p { 
            color: #666;
            font-size: 18px;
            line-height: 1.6;
            margin: 16px 0;
        }
        .cross {
            font-size: 80px;
            color: #dc3545;
            margin-bottom: 20px;
        }
        a {
            background: #667eea;
            color: white;
            padding: 14px 32px;
            border-radius: 12px;
            text-decoration: none;
            display: inline-block;
            margin-top: 24px;
            font-weight: 600;
            transition: transform 0.2s;
        }
        a:hover {
            transform: translateY(-2px);
            background: #5a67d8;
        }
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
// 4. VERIFICAR STATUS DO PAGAMENTO
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
    
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🔐 AUTENTICAÇÃO (SIMPLES E FUNCIONAL)
// ========================

// Gerar token JWT simples
function gerarToken() {
  return jwt.sign(
    { role: 'medico', timestamp: Date.now() }, 
    process.env.JWT_SECRET, 
    { expiresIn: '8h' }
  )
}

// Middleware de autenticação
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.usuario = decoded
    next()
  } catch(e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' })
  }
}

// Endpoint de login (SIMPLES)
app.post('/login', (req, res) => {
  try {
    const { senha } = req.body
    
    if (!senha) {
      return res.status(400).json({ error: 'Senha é obrigatória' })
    }
    
    // Verificação simples de senha
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
  } catch(e) {
    console.error('❌ Erro no login:', e.message)
    res.status(500).json({ error: 'Erro interno no servidor' })
  }
})

// ========================
// 📋 ENDPOINTS DA FILA E PAINEL
// ========================

// Listar todos os atendimentos (protegido)
app.get('/api/atendimentos', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    // Descriptografar dados sensíveis para visualização
    const atendimentosDescriptografados = atendimentos.map(a => ({
      id: a.id,
      paciente_nome: decrypt(a.paciente_nome),
      paciente_telefone: decrypt(a.paciente_telefone),
      paciente_cpf: decrypt(a.paciente_cpf),
      paciente_email: decrypt(a.paciente_email),
      condicao: (() => {
        try {
          const decrypted = decrypt(a.condicao)
          return decrypted ? JSON.parse(decrypted) : { doenca: 'N/A' }
        } catch(e) {
          return { doenca: 'Erro ao descriptografar' }
        }
      })(),
      elegivel: a.elegivel,
      status: a.status,
      pagamento: a.pagamento,
      criado_em: a.criado_em,
      atualizado_em: a.atualizado_em,
      pago_em: a.pago_em
    }))
    
    // Ordenar por data de criação (mais recentes primeiro)
    atendimentosDescriptografados.sort((a, b) => 
      new Date(b.criado_em) - new Date(a.criado_em)
    )
    
    res.json(atendimentosDescriptografados)
  } catch(e) {
    console.error('❌ Erro ao listar atendimentos:', e.message)
    res.status(500).json({ error: 'Erro ao carregar atendimentos' })
  }
})

// Buscar atendimento específico (protegido)
app.get('/api/atendimento/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    res.json({
      id: at.id,
      paciente_nome: decrypt(at.paciente_nome),
      paciente_telefone: decrypt(at.paciente_telefone),
      paciente_cpf: decrypt(at.paciente_cpf),
      paciente_email: decrypt(at.paciente_email),
      condicao: (() => {
        try {
          const decrypted = decrypt(at.condicao)
          return decrypted ? JSON.parse(decrypted) : { doenca: 'N/A' }
        } catch(e) {
          return { doenca: 'Erro ao descriptografar' }
        }
      })(),
      elegivel: at.elegivel,
      status: at.status,
      pagamento: at.pagamento,
      criado_em: at.criado_em,
      atualizado_em: at.atualizado_em,
      pago_em: at.pago_em
    })
  } catch(e) {
    console.error('❌ Erro ao buscar atendimento:', e.message)
    res.status(500).json({ error: 'Erro ao carregar atendimento' })
  }
})

// Listar apenas atendimentos na fila (protegido)
app.get('/api/fila', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    // Filtrar: pagos E com status FILA
    const fila = atendimentos.filter(a => 
      a.pagamento === true && a.status === 'FILA'
    )
    
    const filaDescriptografada = fila.map(a => ({
      id: a.id,
      paciente_nome: decrypt(a.paciente_nome),
      paciente_telefone: decrypt(a.paciente_telefone),
      condicao: (() => {
        try {
          const decrypted = decrypt(a.condicao)
          return decrypted ? JSON.parse(decrypted) : { doenca: 'N/A' }
        } catch(e) {
          return { doenca: 'Erro ao descriptografar' }
        }
      })(),
      status: a.status,
      criado_em: a.criado_em,
      pago_em: a.pago_em
    }))
    
    // Ordenar por data de pagamento (mais antigos primeiro - FIFO)
    filaDescriptografada.sort((a, b) => 
      new Date(a.pago_em) - new Date(b.pago_em)
    )
    
    res.json({
      total: filaDescriptografada.length,
      atendimentos: filaDescriptografada
    })
  } catch(e) {
    console.error('❌ Erro ao listar fila:', e.message)
    res.status(500).json({ error: 'Erro ao carregar fila' })
  }
})

// ========================
// 📊 ESTATÍSTICAS PARA O PAINEL
// ========================
app.get('/api/estatisticas', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    const stats = {
      total: atendimentos.length,
      elegiveis: atendimentos.filter(a => a.elegivel === true).length,
      inelegiveis: atendimentos.filter(a => a.elegivel === false).length,
      pagos: atendimentos.filter(a => a.pagamento === true).length,
      pendentes_pagamento: atendimentos.filter(a => 
        a.elegivel === true && a.pagamento === false && a.status === 'AGUARDANDO_PAGAMENTO'
      ).length,
      naFila: atendimentos.filter(a => 
        a.pagamento === true && a.status === 'FILA'
      ).length,
      aprovados: atendimentos.filter(a => a.status === 'APROVADO').length,
      recusados: atendimentos.filter(a => a.status === 'RECUSADO').length,
      ultimos_30_dias: atendimentos.filter(a => {
        const dataCriacao = new Date(a.criado_em)
        const trintaDiasAtras = new Date()
        trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30)
        return dataCriacao >= trintaDiasAtras
      }).length
    }
    
    res.json(stats)
  } catch(e) {
    console.error('❌ Erro ao buscar estatísticas:', e.message)
    res.status(500).json({ error: 'Erro ao carregar estatísticas' })
  }
})

// ========================
// 🔄 WEBHOOK PARA ATUALIZAR STATUS (USADO PELO STRIPE)
// ========================
app.post('/api/webhook/atualizar-status', async (req, res) => {
  try {
    const { atendimentoId, status } = req.body
    
    if (!atendimentoId || !status) {
      return res.status(400).json({ error: 'atendimentoId e status são obrigatórios' })
    }
    
    await db.atualizarStatus(atendimentoId, status)
    
    res.json({ success: true, message: 'Status atualizado' })
  } catch(e) {
    console.error('❌ Erro no webhook de status:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 👨‍⚕️ DECISÃO MÉDICA (COMPLETO E MELHORADO)
// ========================

// Endpoint principal de decisão médica
app.post('/api/decisao/:id', auth, async (req, res) => {
  try {
    const { id } = req.params
    const { decisao, observacao, medicamento, posologia } = req.body
    
    // 1. VALIDAÇÕES INICIAIS
    if (!decisao || (decisao !== 'APROVAR' && decisao !== 'RECUSAR')) {
      return res.status(400).json({ 
        error: 'Decisão inválida. Use "APROVAR" ou "RECUSAR"' 
      })
    }
    
    // 2. BUSCAR ATENDIMENTO
    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    // 3. VERIFICAR SE JÁ FOI DECIDIDO
    if (at.status === 'APROVADO' || at.status === 'RECUSADO') {
      return res.status(400).json({ 
        error: `Este atendimento já foi ${at.status === 'APROVADO' ? 'aprovado' : 'recusado'}` 
      })
    }
    
    // 4. VERIFICAR SE PAGAMENTO FOI CONFIRMADO
    if (!at.pagamento) {
      return res.status(400).json({ 
        error: 'Pagamento não confirmado. Aguarde o pagamento do paciente.' 
      })
    }
    
    // 5. PROCESSAR DECISÃO
    const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
    const dataDecisao = new Date().toISOString()
    
    // 6. ATUALIZAR ATENDIMENTO COM DETALHES DA DECISÃO
    const condicaoAtual = JSON.parse(decrypt(at.condicao || '{}'))
    
    const atendimentoAtualizado = {
      ...at,
      status: novoStatus,
      decisao: {
        status: novoStatus,
        data: dataDecisao,
        medico: req.usuario?.role || 'medico',
        observacao: observacao || (decisao === 'APROVAR' ? 'Aprovado conforme critérios clínicos' : 'Não atende aos critérios estabelecidos'),
        medicamento_prescrito: decisao === 'APROVAR' ? (medicamento || gerarMedicacao(condicaoAtual.tipo)) : null,
        posologia: posologia || (decisao === 'APROVAR' ? 'Uso contínuo conforme orientação médica' : null)
      },
      atualizado_em: dataDecisao
    }
    
    await db.salvarAtendimento(atendimentoAtualizado)
    
    // 7. GERAR PRONTUÁRIO SE APROVADO
    let prontuario = null
    if (decisao === 'APROVAR') {
      prontuario = gerarProntuario(at)
    }
    
    // 8. ENVIAR NOTIFICAÇÃO WHATSAPP
    const telefone = decrypt(at.paciente_telefone)
    const nome = decrypt(at.paciente_nome)
    
    if (telefone) {
      let mensagemWhatsApp = ''
      
      if (decisao === 'APROVAR') {
        mensagemWhatsApp = `✅ *ÓTIMAS NOTÍCIAS, ${nome.toUpperCase()}!* ✅\n\n` +
                          `Sua solicitação foi *APROVADA* pelo nosso corpo clínico.\n\n` +
                          `📋 *Medicamento prescrito:* ${atendimentoAtualizado.decisao.medicamento_prescrito}\n` +
                          `💊 *Posologia:* ${atendimentoAtualizado.decisao.posologia}\n\n` +
                          `📄 Você receberá sua receita digital em breve.\n\n` +
                          `🔗 Acompanhe: ${BASE_URL}/painel-medico\n\n` +
                          `👨‍⚕️ Doctor Prescreve - Cuidando de você!`
      } else {
        mensagemWhatsApp = `❌ *ATENÇÃO, ${nome.toUpperCase()}!* ❌\n\n` +
                          `Sua solicitação foi *RECUSADA* pelo nosso corpo clínico.\n\n` +
                          `📝 *Motivo:* ${observacao || 'Não atende aos critérios clínicos estabelecidos'}\n\n` +
                          `🔗 Para mais informações, acesse: ${BASE_URL}/painel-medico\n\n` +
                          `👨‍⚕️ Doctor Prescreve - Sempre à disposição!`
      }
      
      await enviarWhatsAppOficial(telefone, mensagemWhatsApp)
    }
    
    // 9. SE APROVADO, GERAR LINK PARA RECEITA
    let receitaUrl = null
    if (decisao === 'APROVAR') {
      receitaUrl = `${BASE_URL}/api/receita/${id}`
    }
    
    // 10. REGISTRAR LOG DA DECISÃO
    console.log(`📝 Decisão médica: ${novoStatus} - Atendimento: ${id} - Paciente: ${nome}`)
    
    // 11. RESPOSTA COMPLETA
    res.json({
      success: true,
      atendimentoId: id,
      status: novoStatus,
      decisao: atendimentoAtualizado.decisao,
      prontuario: prontuario,
      receitaUrl: receitaUrl,
      notificacao_enviada: !!telefone,
      mensagem: `Atendimento ${novoStatus.toLowerCase()} com sucesso`
    })
    
  } catch(e) {
    console.error('❌ Erro ao processar decisão:', e.message)
    res.status(500).json({ 
      error: 'Erro interno ao processar decisão médica',
      detalhe: e.message 
    })
  }
})

// ========================
// 📄 ENDPOINT PARA GERAR RECEITA (APÓS APROVAÇÃO)
// ========================
app.get('/api/receita/:id', auth, async (req, res) => {
  try {
    const { id } = req.params
    
    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    if (at.status !== 'APROVADO') {
      return res.status(400).json({ error: 'Receita disponível apenas para atendimentos aprovados' })
    }
    
    const nome = decrypt(at.paciente_nome)
    const condicao = JSON.parse(decrypt(at.condicao || '{}'))
    const medicamento = at.decisao?.medicamento_prescrito || gerarMedicacao(condicao.tipo)
    const posologia = at.decisao?.posologia || 'Uso contínuo conforme orientação médica'
    
    // Gerar PDF (simplificado - você pode integrar com gerador de PDF real)
    const receita = {
      numero: `REC-${id.substring(0, 8)}`,
      data: new Date().toISOString(),
      paciente: nome,
      medicamento: medicamento,
      posologia: posologia,
      validade: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 dias
      medico: 'Dr. Plantonista - CRM 12345',
      assinatura_digital: crypto.createHash('sha256').update(id + process.env.JWT_SECRET).digest('hex')
    }
    
    res.json(receita)
    
  } catch(e) {
    console.error('❌ Erro ao gerar receita:', e.message)
    res.status(500).json({ error: 'Erro ao gerar receita' })
  }
})

// ========================
// 📋 ENDPOINT PARA HISTÓRICO DE DECISÕES
// ========================
app.get('/api/decisoes', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    const decisoes = atendimentos
      .filter(a => a.status === 'APROVADO' || a.status === 'RECUSADO')
      .map(a => ({
        id: a.id,
        paciente_nome: decrypt(a.paciente_nome),
        status: a.status,
        decisao: a.decisao,
        criado_em: a.criado_em,
        atualizado_em: a.atualizado_em
      }))
      .sort((a, b) => new Date(b.atualizado_em) - new Date(a.atualizado_em))
    
    res.json({
      total: decisoes.length,
      aprovados: decisoes.filter(d => d.status === 'APROVADO').length,
      recusados: decisoes.filter(d => d.status === 'RECUSADO').length,
      decisoes: decisoes
    })
    
  } catch(e) {
    console.error('❌ Erro ao buscar decisões:', e.message)
    res.status(500).json({ error: 'Erro ao carregar histórico' })
  }
})

// ========================
// 🔄 ENDPOINT PARA REVISÃO DE DECISÃO (CASO NECESSÁRIO)
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
    const novoStatus = novaDecisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
    
    // Registrar revisão
    const revisao = {
      data: new Date().toISOString(),
      status_anterior: statusAnterior,
      status_novo: novoStatus,
      motivo: motivoRevisao || 'Revisão médica',
      observacao: observacao,
      medico: req.usuario?.role || 'medico_revisor'
    }
    
    const revisoesAnteriores = at.revisoes || []
    
    const atendimentoAtualizado = {
      ...at,
      status: novoStatus,
      decisao: {
        ...at.decisao,
        revisado: true,
        revisao: revisao,
        status: novoStatus,
        data_revisao: new Date().toISOString()
      },
      revisoes: [...revisoesAnteriores, revisao],
      atualizado_em: new Date().toISOString()
    }
    
    await db.salvarAtendimento(atendimentoAtualizado)
    
    // Notificar paciente sobre a revisão
    const telefone = decrypt(at.paciente_telefone)
    if (telefone) {
      const mensagem = `🔄 *REVISÃO MÉDICA* 🔄\n\n` +
                      `Sua solicitação foi revisada.\n` +
                      `Status anterior: ${statusAnterior}\n` +
                      `Novo status: ${novoStatus}\n\n` +
                      `📝 Motivo: ${motivoRevisao || 'Reanálise do caso'}\n\n` +
                      `🔗 Acesse para mais detalhes: ${BASE_URL}/painel-medico`
      
      await enviarWhatsAppOficial(telefone, mensagem)
    }
    
    res.json({
      success: true,
      atendimentoId: id,
      status_anterior: statusAnterior,
      status_novo: novoStatus,
      revisao: revisao,
      mensagem: `Decisão revisada com sucesso`
    })
    
  } catch(e) {
    console.error('❌ Erro ao revisar decisão:', e.message)
    res.status(500).json({ error: 'Erro ao revisar decisão' })
  }
})

// ========================
// 📊 ENDPOINT PARA ESTATÍSTICAS DAS DECISÕES
// ========================
app.get('/api/estatisticas/decisoes', auth, async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    const aprovados = atendimentos.filter(a => a.status === 'APROVADO')
    const recusados = atendimentos.filter(a => a.status === 'RECUSADO')
    
    // Calcular tempo médio de resposta
    const temposResposta = atendimentos
      .filter(a => a.decisao && a.decisao.data)
      .map(a => {
        const criado = new Date(a.criado_em)
        const decidido = new Date(a.decisao.data)
        return (decidido - criado) / (1000 * 60 * 60) // horas
      })
    
    const tempoMedioResposta = temposResposta.length > 0 
      ? temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length 
      : 0
    
    // Motivos mais comuns de recusa
    const motivosRecusa = recusados
      .map(a => a.decisao?.observacao || 'Não informado')
      .reduce((acc, motivo) => {
        acc[motivo] = (acc[motivo] || 0) + 1
        return acc
      }, {})
    
    res.json({
      total_decisoes: aprovados.length + recusados.length,
      aprovados: {
        total: aprovados.length,
        percentual: atendimentos.length > 0 ? (aprovados.length / atendimentos.length * 100).toFixed(2) : 0
      },
      recusados: {
        total: recusados.length,
        percentual: atendimentos.length > 0 ? (recusados.length / atendimentos.length * 100).toFixed(2) : 0,
        principais_motivos: motivosRecusa
      },
      tempo_medio_resposta: {
        horas: tempoMedioResposta.toFixed(2),
        minutos: (tempoMedioResposta * 60).toFixed(0)
      }
    })
    
  } catch(e) {
    console.error('❌ Erro nas estatísticas de decisões:', e.message)
    res.status(500).json({ error: 'Erro ao carregar estatísticas' })
  }
})

// ========================
// 🧠 MOTOR CLÍNICO AVANÇADO
// ========================

function detectarTipo(texto) {
  if (!texto) return 'OUTRO'
  const lowerText = texto.toLowerCase()
  
  if (lowerText.includes('hipert') || lowerText.includes('pressão')) return 'HAS'
  if (lowerText.includes('diabetes') || lowerText.includes('açucar')) return 'DIABETES'
  if (lowerText.includes('tireo') || lowerText.includes('hipotireoidismo')) return 'HIPOTIREOIDISMO'
  if (lowerText.includes('colesterol') || lowerText.includes('dislipidemia')) return 'DISLIPIDEMIA'
  if (lowerText.includes('ansiedade') || lowerText.includes('depressão')) return 'SAUDE_MENTAL'
  
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

// ========================
// 📋 PRONTUÁRIO COMPLETO
// ========================

// 1. PRONTUÁRIO BÁSICO (HERDADO DO MOTOR CLÍNICO)
app.get('/api/prontuario/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    // Descriptografar dados
    const condicaoCriptografada = decrypt(at.condicao || '{}')
    let condicao = {}
    try {
      condicao = JSON.parse(condicaoCriptografada)
    } catch(e) {
      condicao = { doenca: 'Não especificada', tipo: 'OUTRO' }
    }
    
    const tipo = condicao.tipo || detectarTipo(condicao.doenca || '')
    const dadosPaciente = {
      nome: decrypt(at.paciente_nome),
      cpf: decrypt(at.paciente_cpf),
      telefone: decrypt(at.paciente_telefone),
      email: decrypt(at.paciente_email)
    }
    
    // Gerar prontuário completo
    const prontuario = {
      queixa: gerarQueixa(tipo, condicao),
      historia: gerarHistoria(tipo, condicao),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, condicao),
      medicacao: gerarMedicacao(tipo, condicao),
      posologia: gerarPosologia(tipo),
      recomendacoes: gerarRecomendacoes(tipo),
      score_risco: calcularScoreRisco(tipo, condicao),
      data_atendimento: new Date().toISOString(),
      validade_receita: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    }
    
    res.json({
      paciente: dadosPaciente,
      condicao: condicao,
      prontuario: prontuario,
      atendimento: {
        id: at.id,
        status: at.status,
        criado_em: at.criado_em,
        pago_em: at.pago_em
      }
    })
    
  } catch(e) {
    console.error('❌ Erro ao gerar prontuário:', e.message)
    res.status(500).json({ error: 'Erro ao gerar prontuário' })
  }
})

// 2. PRONTUÁRIO EXPANDIDO (COM DECISÃO MÉDICA)
app.get('/api/prontuario/:id/completo', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const condicao = JSON.parse(decrypt(at.condicao || '{}'))
    const tipo = condicao.tipo || detectarTipo(condicao.doenca || '')
    
    const prontuarioBase = {
      paciente: decrypt(at.paciente_nome),
      queixa: gerarQueixa(tipo, condicao),
      historia: gerarHistoria(tipo, condicao),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, condicao),
      medicacao: gerarMedicacao(tipo, condicao),
      posologia: gerarPosologia(tipo)
    }
    
    // Adicionar dados da decisão médica se existir
    let decisaoMedica = null
    if (at.decisao) {
      decisaoMedica = {
        status: at.decisao.status,
        data: at.decisao.data,
        observacao: at.decisao.observacao,
        medicamento_prescrito: at.decisao.medicamento_prescrito,
        posologia: at.decisao.posologia
      }
    }
    
    res.json({
      ...prontuarioBase,
      decisao_medica: decisaoMedica,
      prontuario_completo: true,
      gerado_em: new Date().toISOString()
    })
    
  } catch(e) {
    console.error('❌ Erro ao gerar prontuário completo:', e.message)
    res.status(500).json({ error: 'Erro ao gerar prontuário completo' })
  }
})

// 3. PRONTUÁRIO RESUMIDO (PARA WhatsApp)
app.get('/api/prontuario/:id/resumido', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const condicao = JSON.parse(decrypt(at.condicao || '{}'))
    const tipo = condicao.tipo || detectarTipo(condicao.doenca || '')
    
    const resumo = {
      paciente: decrypt(at.paciente_nome),
      doenca: condicao.doenca || 'Não especificada',
      conduta_resumida: gerarConduta(tipo, condicao),
      medicacao: gerarMedicacao(tipo, condicao),
      proximo_retorno: "3 meses"
    }
    
    res.json(resumo)
    
  } catch(e) {
    console.error('❌ Erro ao gerar prontuário resumido:', e.message)
    res.status(500).json({ error: 'Erro ao gerar resumo' })
  }
})

// 4. PDF PRONTUÁRIO (HTML PARA GERAR PDF)
app.get('/api/prontuario/:id/pdf', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const condicao = JSON.parse(decrypt(at.condicao || '{}'))
    const tipo = condicao.tipo || detectarTipo(condicao.doenca || '')
    
    const prontuario = {
      paciente_nome: decrypt(at.paciente_nome),
      paciente_cpf: decrypt(at.paciente_cpf),
      queixa: gerarQueixa(tipo, condicao),
      historia: gerarHistoria(tipo, condicao),
      exame_fisico: gerarExameFisico(tipo),
      conduta: gerarConduta(tipo, condicao),
      medicacao: gerarMedicacao(tipo, condicao),
      posologia: gerarPosologia(tipo),
      recomendacoes: gerarRecomendacoes(tipo)
    }
    
    // Gerar HTML do prontuário
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
        <div class="section-title">👤 Dados do Paciente</div>
        <div class="content">
          <strong>Nome:</strong> ${prontuario.paciente_nome}<br>
          <strong>CPF:</strong> ${prontuario.paciente_cpf || 'Não informado'}
        </div>
      </div>
      
      <div class="section">
        <div class="section-title">📋 Queixa Principal</div>
        <div class="content">${prontuario.queixa}</div>
      </div>
      
      <div class="section">
        <div class="section-title">📖 História Clínica</div>
        <div class="content">${prontuario.historia}</div>
      </div>
      
      <div class="section">
        <div class="section-title">🩺 Exame Físico</div>
        <div class="content">${prontuario.exame_fisico}</div>
      </div>
      
      <div class="section">
        <div class="section-title">💊 Conduta e Prescrição</div>
        <div class="content">
          <strong>Medicação:</strong> ${prontuario.medicacao}<br>
          <strong>Posologia:</strong> ${prontuario.posologia}<br>
          <strong>Conduta:</strong> ${prontuario.conduta}
        </div>
      </div>
      
      <div class="section">
        <div class="section-title">📌 Recomendações</div>
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
    
  } catch(e) {
    console.error('❌ Erro ao gerar PDF:', e.message)
    res.status(500).json({ error: 'Erro ao gerar PDF do prontuário' })
  }
})

// 5. EXPORTAR PRONTUÁRIO JSON (PARA INTEGRAÇÕES)
app.get('/api/prontuario/:id/export', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const condicao = JSON.parse(decrypt(at.condicao || '{}'))
    const tipo = condicao.tipo || detectarTipo(condicao.doenca || '')
    
    const exportData = {
      metadata: {
        id: at.id,
        exportado_em: new Date().toISOString(),
        versao: "1.0",
        sistema: "Doctor Prescreve"
      },
      paciente: {
        nome: decrypt(at.paciente_nome),
        cpf: decrypt(at.paciente_cpf),
        telefone: decrypt(at.paciente_telefone),
        email: decrypt(at.paciente_email)
      },
      clinico: {
        condicao: condicao.doenca,
        tipo: tipo,
        queixa: gerarQueixa(tipo, condicao),
        historia: gerarHistoria(tipo, condicao),
        exame_fisico: gerarExameFisico(tipo),
        conduta: gerarConduta(tipo, condicao),
        medicacao: gerarMedicacao(tipo, condicao),
        posologia: gerarPosologia(tipo),
        recomendacoes: gerarRecomendacoes(tipo),
        score_risco: calcularScoreRisco(tipo, condicao)
      },
      decisao_medica: at.decisao || null,
      status: at.status,
      datas: {
        criacao: at.criado_em,
        pagamento: at.pago_em,
        atualizacao: at.atualizado_em
      }
    }
    
    res.json(exportData)
    
  } catch(e) {
    console.error('❌ Erro ao exportar prontuário:', e.message)
    res.status(500).json({ error: 'Erro ao exportar prontuário' })
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
