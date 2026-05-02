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
// 👨‍⚕️ DECISÃO MÉDICA (APROVAR/RECUSAR)
// ========================
app.post('/api/decisao/:id', auth, async (req, res) => {
  try {
    const { decisao, observacao } = req.body
    const { id } = req.params
    
    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    let novoStatus = ''
    let mensagem = ''
    
    if (decisao === 'APROVAR') {
      novoStatus = 'APROVADO'
      mensagem = '✅ Receita aprovada! Você receberá seu documento por WhatsApp em breve.'
    } else if (decisao === 'RECUSAR') {
      novoStatus = 'RECUSADO'
      mensagem = '❌ Infelizmente sua solicitação não foi aprovada. Motivo: ' + (observacao || 'não atende aos critérios clínicos')
    } else {
      return res.status(400).json({ error: 'Decisão inválida. Use APROVAR ou RECUSAR' })
    }
    
    // Atualizar status do atendimento
    await db.atualizarStatus(id, novoStatus)
    
    // Enviar notificação WhatsApp
    const telefone = decrypt(at.paciente_telefone)
    const nome = decrypt(at.paciente_nome)
    
    if (telefone) {
      const msg = `Olá ${nome}!\n\n${mensagem}\n\n🔗 Acesse o portal: ${BASE_URL}/painel-medico`
      await enviarWhatsAppOficial(telefone, msg)
    }
    
    res.json({ 
      success: true, 
      novoStatus,
      mensagem: `Atendimento ${novoStatus} com sucesso`
    })
  } catch(e) {
    console.error('❌ Erro ao processar decisão:', e.message)
    res.status(500).json({ error: 'Erro ao processar decisão médica' })
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
// 🚀 SERVER
// ========================

app.get('/', (req, res) => {
  res.json({ status: 'online', versao: '1.0' })
})

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`)
})
