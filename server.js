require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy')

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

const app = express()

const BASE_URL = process.env.BASE_URL 
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)

// ========================
// 🔐 VALIDAÇÃO
// ========================
;['ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY'].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ ERRO: ${v} não definida em .env`)
    process.exit(1)
  }
})

// ========================
// 🔐 CRIPTOGRAFIA (CORRIGIDO)
// ========================
const encryptionKeyHex = process.env.ENCRYPTION_KEY

// Valida se é hexadecimal com 64 caracteres
if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
  console.error('❌ ERRO: ENCRYPTION_KEY deve ser 64 caracteres hexadecimais')
  console.error('   Execute: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}

const key = Buffer.from(encryptionKeyHex, 'hex')
console.log('✅ ENCRYPTION_KEY válida (32 bytes = 256 bits)')

function encrypt(text) {
  if (!text) return null
  try {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
  } catch(e) {
    console.error('❌ Erro ao criptografar:', e.message)
    return null
  }
}

function decrypt(text) {
  if (!text) return null
  try {
    const [ivHex, data] = text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch(e) {
    return "[Erro ao descriptografar]"
  }
}

// ========================
// 💾 BANCO DE DADOS (FILE-BASED)
// ========================
const fs = require('fs')
const path = require('path')

const DB_DIR = 'data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = {
  async salvarAtendimento(at) {
    const file = path.join(DB_DIR, `atendimento_${at.id}.json`)
    fs.writeFileSync(file, JSON.stringify(at, null, 2))
    console.log(`✅ Atendimento salvo: ${at.id}`)
  },

  async buscarAtendimentoPorId(id) {
    const file = path.join(DB_DIR, `atendimento_${id}.json`)
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    return null
  },

  async getAtendimentos() {
    const files = fs.readdirSync(DB_DIR).filter(f => f.startsWith('atendimento_'))
    return files.map(f => JSON.parse(fs.readFileSync(path.join(DB_DIR, f), 'utf8')))
  },

  async atualizarStatus(id, novoStatus) {
    const at = await this.buscarAtendimentoPorId(id)
    if (at) {
      at.status = novoStatus
      at.atualizado_em = new Date().toISOString()
      await this.salvarAtendimento(at)
      console.log(`✅ Status atualizado: ${id} -> ${novoStatus}`)
    }
  },
 
  async atualizarStatusPagamento(id, pago, status) {
    const at = await this.buscarAtendimentoPorId(id)
    if (at) {
      at.pagamento = pago
      at.status = status
      at.pago_em = new Date().toISOString()
      await this.salvarAtendimento(at)
      console.log(`✅ Pagamento confirmado: ${id}`)
    }
  }
}

      app.get('/api/historico/:cpf', auth, async (req, res) => {
  try {
    const cpf = req.params.cpf

    const atendimentos = await db.getAtendimentos()

    const historico = atendimentos
      .filter(a => decrypt(a.paciente_cpf) === cpf)
      .map(a => ({
        id: a.id,
        data: a.criado_em,
        status: a.status,
        condicao: a.condicao ? JSON.parse(decrypt(a.condicao)) : null
      }))

    res.json(historico)

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📱 WHATSAPP (CLOUD API OFICIAL)
// ========================
async function enviarWhatsAppOficial(numero, mensagem) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_TOKEN

  if (!numero || !phoneNumberId || !token) {
    console.warn('⚠️ WhatsApp não configurado corretamente')
    return
  }

  const telefone = numero.replace(/\D/g, '')

  if (telefone.length < 11) {
    console.warn('⚠️ Número inválido:', telefone)
    return
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefone,
        text: { body: mensagem }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    )

    console.log(`✅ WhatsApp oficial enviado para ${telefone}`)
  } catch (e) {
    console.error('❌ Erro WhatsApp:', e.response?.data || e.message)
  }
}
async function enviarReceitaWhatsApp(numero, urlPdf) {
  await enviarWhatsAppOficial(numero, `📄 Sua receita:\n${urlPdf}`)
}

// ========================
// 🛡️ MIDDLEWARES
// ========================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}))

app.use(cors())
app.use(express.json())
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))

// ========================
// 🔐 AUTH
// ========================
const gerarToken = () => jwt.sign({ role: 'medico' }, process.env.JWT_SECRET, { expiresIn: '8h' })

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) throw new Error('Token ausente')
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch(e) {
    return res.status(401).json({ error: 'Não autorizado', detalhes: e.message })
  }
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({ error: 'Dados inválidos. Requeridos: paciente.nome, triagem.doencas' })
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
      await enviarWhatsApp(paciente.telefone, msg)
    } else {
      const msg = `❌ Infelizmente, sua condição não se qualifica para renovação remota.\nProcure atendimento presencial.`
      await enviarWhatsApp(paciente.telefone, msg)
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
// 💳 PAGAMENTO
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: { atendimentoId: req.params.id },
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: {
            name: 'Consulta Assíncrona - Doctor Prescreve',
            description: 'Renovação de receita médica com avaliação de médico licenciado',
            images: ['https://images.unsplash.com/photo-1576091160550-112173f7f869?w=500']
          },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`
    })

    console.log(`💳 Session criada: ${session.id}`)
    res.json({ url: session.url, sessionId: session.id })
  } catch(e) {
    console.error('❌ Erro Stripe:', e.message)
    res.status(500).json({ error: 'Erro ao gerar pagamento' })
  }
})

// ========================
// 🔥 STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado')
    return res.json({ received: true })
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const atendimentoId = session.metadata?.atendimentoId

      if (atendimentoId) {
        const at = await db.buscarAtendimentoPorId(atendimentoId)
        if (at && !at.pagamento) {
          await db.atualizarStatusPagamento(atendimentoId, true, 'FILA')

          const telefone = decrypt(at.paciente_telefone)
          const nome = decrypt(at.paciente_nome)

          const msg = `✅ Pagamento confirmado!\n\n👨‍⚕️ Seu atendimento #${atendimentoId.substring(0, 8)} entrou na fila de avaliação.\n\n⏳ Você receberá a resposta em até 24h úteis.\n\n🔗 Acompanhe: ${BASE_URL}/painel-medico`
          await enviarWhatsApp(telefone, msg)

          console.log(`💰 Pagamento processado para ${nome}`)
        }
      }
    }

    res.json({ received: true })
  } catch(e) {
    console.error('❌ Webhook error:', e.message)
    res.status(400).send(`Webhook Error: ${e.message}`)
  }
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login', (req, res) => {
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
    token,
    mensagem: 'Login realizado com sucesso'
  })
})

// ========================
// 📱 WEBHOOK WHATSAPP
// ========================
app.post('/webhook/whatsapp', (req, res) => {
  try {
    console.log('📩 WhatsApp recebido:')
    console.log(JSON.stringify(req.body, null, 2))
  } catch (e) {
    console.error('Erro webhook WhatsApp:', e)
  }

  res.sendStatus(200)
})

// ==========================================
// 🏥 ROTAS DO SERVIDOR (BACK-END)
// ==========================================

app.get('/healthz', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        version: '4.1' 
    });
});

app.get('/success', (req, res) => {
    res.send(`<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
        .box { background: white; padding: 40px; border-radius: 16px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1 { color: #28a745; }
        a { background: #1a6b8a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="box">
        <h1>✅ Pagamento Confirmado!</h1>
        <p>Seu atendimento foi registrado com sucesso.</p>
        <a href="/painel-medico">📊 Voltar ao Painel</a>
    </div>
</body>
</html>`);
});

app.get('/cancel', (req, res) => {
    res.send(`<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
        .box { background: white; padding: 40px; border-radius: 16px; max-width: 500px; margin: 0 auto; }
        h1 { color: #dc3545; }
        a { background: #1a6b8a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="box">
        <h1>❌ Pagamento Cancelado</h1>
        <a href="/">🏠 Voltar ao Início</a>
    </div>
</body>
</html>`);
});

// ========================
// 🏥 PAINEL MÉDICO
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

  MdHub.event.add("prescription:completed", async function (data) {
  await fetch(API_URL + '/api/receita', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      ...data,
      atendimentoId: window.atendimentoAtual
    })
  })
})
        
        .login-container {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%);
        }
        
        .login-card {
            background: white;
            border-radius: 16px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        
        .login-card h2 {
            color: #1a6b8a;
            margin-bottom: 24px;
            text-align: center;
            font-size: 24px;
        }
        
        .login-card input {
            width: 100%;
            padding: 12px 16px;
            margin-bottom: 20px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 16px;
        }
        
        .login-card button {
            width: 100%;
            padding: 12px;
            background: #1a6b8a;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
        }
        
        .login-card button:hover { background: #0d4f6b; }
        
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        
        .painel-header {
            background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%);
            color: white;
            padding: 20px;
            border-radius: 16px;
            margin-bottom: 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .painel-header h1 { font-size: 28px; }
        
        .logout-btn {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid white;
            padding: 10px 20px;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            font-weight: bold;
        }
        
        .logout-btn:hover { background: rgba(255, 255, 255, 0.3); }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            border-radius: 16px;
            padding: 20px;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .stat-number {
            font-size: 36px;
            font-weight: bold;
            color: #1a6b8a;
        }
        
        .filtros {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        
        .filtro-btn {
            background: #e9ecef;
            border: none;
            padding: 10px 24px;
            border-radius: 30px;
            cursor: pointer;
            font-weight: 600;
        }
        
        .filtro-btn.ativo {
            background: #1a6b8a;
            color: white;
        }
        
        .table-container {
            background: white;
            border-radius: 16px;
            overflow-x: auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th, td {
            padding: 16px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }
        
        th {
            background: #f8f9fa;
            font-weight: 600;
        }
        
        .status-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
        }
        
        .status-aprovado { background: #d4edda; color: #155724; }
        .status-recusado { background: #f8d7da; color: #721c24; }
        .status-fila { background: #fff3cd; color: #856404; }
        .status-inelegivel { background: #e2e3e5; color: #383d41; }
        
        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            margin: 2px;
            font-weight: 600;
            font-size: 12px;
        }
        
        .btn-primary { background: #28a745; color: white; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-info { background: #17a2b8; color: white; }
        
        .error-message {
            color: #dc3545;
            margin-top: 10px;
            text-align: center;
            font-weight: 600;
        }
        
        #painel { display: none; }
    </style>
</head>
<body>
    <div id="login" class="login-container">
        <div class="login-card">
            <h2>🔐 Painel Médico</h2>
            <p style="text-align: center; color: #666; margin-bottom: 20px;">Doctor Prescreve v4.1</p>
            <input type="password" id="senha" placeholder="Digite sua senha" onkeypress="if(event.key==='Enter') login()">
            <button onclick="login()">🔓 Entrar</button>
            <div id="erroMsg" class="error-message" style="display: none;">❌ Senha incorreta!</div>
        </div>
    </div>

    <div id="painel">
        <div class="container">
            <div class="painel-header">
                <h1>📊 Doctor Prescreve - Painel Médico</h1>
                <button class="logout-btn" onclick="logout()">🚪 Sair</button>
            </div>

            <div class="stats-grid" id="stats">⏳ Carregando estatísticas...</div>

            <div class="filtros">
                <button class="filtro-btn ativo" onclick="filtrar('todos')">📋 Todos</button>
                <button class="filtro-btn" onclick="filtrar('fila')">⏳ Na Fila</button>
                <button class="filtro-btn" onclick="filtrar('aprovados')">✅ Aprovados</button>
                <button class="filtro-btn" onclick="filtrar('recusados')">❌ Recusados</button>
            </div>

            <div class="table-container" id="atendimentos">⏳ Carregando atendimentos...</div>
        </div>
    </div>

    <script>
        const API_URL = window.location.origin
        let token = ''
        let dadosAtendimentos = []
        let filtroAtual = 'todos'

async function aprovarEPrescrever(id) {
    try {
        const res = await fetch(API_URL + '/api/decisao/' + id, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ decisao: 'APROVAR' })
        });

        const result = await res.json();
        if (!result.success) {
            return alert('Erro ao aprovar');
        }

        window.atendimentoAtual = id;

        const prontuarioRes = await fetch(API_URL + '/api/prontuario/' + id, {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        const data = await prontuarioRes.json();

        // Chama a função da Memed passando os dados do prontuário
        await abrirMemed(data);

    } catch (e) {
        console.error(e);
        alert('Erro no processo');
    }
}

async function salvarReceitaBackend(data) {
    await fetch(API_URL + '/api/receita', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
            ...data,
            atendimentoId: window.atendimentoAtual
        })
    });
}

async function abrirMemed(data) {
    // Abrir a plataforma de prescrição
    await MdHub.command.send("plataforma.prescricao", "newPrescription");

    // Enviar dados adicionais do paciente
    await MdHub.command.send("plataforma.prescricao", "setAdditionalData", {
        header: [
            { Nome: data.paciente.nome },
            { CPF: data.paciente.cpf },
            { Doença: data.condicao.doenca }
        ]
    });

// Evento da Memed → salva no backend
MdHub.event.add("prescription:completed", async function (data) {
    console.log("📄 Receita finalizada:", data);
    await salvarReceitaBackend(data);
});

async function recusarAtendimento(id) {
    try {
        await fetch(API_URL + '/api/decisao/' + id, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ decisao: 'RECUSAR' })
        });
        alert('Paciente recusado');
    } catch (e) {
        alert('Erro ao recusar atendimento');
    }
}

// Atualização automática do painel
setInterval(() => {
    const painel = document.getElementById('painel');
    if (painel && painel.style.display !== 'none') {
        carregarDados();
    }
}, 30000);

        async function login() {
            const senha = document.getElementById('senha').value
            if (!senha) return alert('Digite a senha!')

            try {
                const res = await fetch(API_URL + '/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ senha })
                })
                const data = await res.json()
                if (data.token) {
                    token = data.token
                    document.getElementById('login').style.display = 'none'
                    document.getElementById('painel').style.display = 'block'
                    carregarDados()
                } else {
                    document.getElementById('erroMsg').style.display = 'block'
                }
            } catch(e) {
                alert('Erro ao fazer login: ' + e.message)
            }
        }

        function logout() {
            token = ''
            document.getElementById('login').style.display = 'flex'
            document.getElementById('painel').style.display = 'none'
            document.getElementById('senha').value = ''
        }

        async function carregarDados() {
            await carregarEstatisticas()
            await carregarAtendimentos()
        }

        async function carregarEstatisticas() {
            try {
                const res = await fetch(API_URL + '/api/estatisticas', {
                    headers: { 'Authorization': 'Bearer ' + token }
                })
                const stats = await res.json()
                document.getElementById('stats').innerHTML =
                    '<div class="stat-card"><div class="stat-number">' + (stats.total || 0) + '</div><div>📋 Total</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.elegiveis || 0) + '</div><div>✅ Elegíveis</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.pagos || 0) + '</div><div>💰 Pagos</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.naFila || 0) + '</div><div>⏳ Na Fila</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.aprovados || 0) + '</div><div>✅ Aprovados</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.recusados || 0) + '</div><div>❌ Recusados</div></div>'
            } catch(e) {
                console.error('Erro ao carregar estatísticas:', e)
            }
        }

        async function carregarAtendimentos() {
            try {
                const res = await fetch(API_URL + '/api/atendimentos', {
                    headers: { 'Authorization': 'Bearer ' + token }
                })
                dadosAtendimentos = await res.json()
                renderizarAtendimentos()
            } catch(e) {
                console.error('Erro ao carregar atendimentos:', e)
                document.getElementById('atendimentos').innerHTML = '<div style="text-align: center; padding: 40px;">❌ Erro ao carregar</div>'
            }
        }

        function filtrar(tipo) {
            filtroAtual = tipo
            document.querySelectorAll('.filtro-btn').forEach(btn => btn.classList.remove('ativo'))
            event.target.classList.add('ativo')
            renderizarAtendimentos()
        }

async function abrirProntuario(id) {
  try {
    const res = await fetch(API_URL + '/api/prontuario/' + id, {
      headers: { 'Authorization': 'Bearer ' + token }
    })

    const data = await res.json()

  async function abrirMemed(data) {

  await MdHub.command.send("plataforma.prescricao", "newPrescription")

  await MdHub.command.send("plataforma.prescricao", "setAdditionalData", {
    header: [
      { Nome: data.paciente.nome },
      { CPF: data.paciente.cpf },
      { Doença: data.condicao.doenca }
    ],
    footer: "Doctor Prescreve"
  })

  // 1. Abre prescrição
  await MdHub.command.send("plataforma.prescricao", "newPrescription")

  // 2. Preenche dados do paciente
  await MdHub.command.send("plataforma.prescricao", "setAdditionalData", {
    header: [
      { Nome: data.paciente.nome },
      { CPF: data.paciente.cpf },
      { Doença: data.condicao.doenca }
    ],
    footer: "Atendimento Doctor Prescreve"
  })

  // 3. Adiciona medicamento automático
  await MdHub.command.send("plataforma.prescricao", "addItem", {
    nome: data.medicacao,
    posologia: "<p>Uso contínuo conforme orientação médica</p>",
    quantidade: 30
  })

}
       
        function renderizarAtendimentos() {
            let filtrados = [...dadosAtendimentos]
            if (filtroAtual === 'fila') {
                filtrados = filtrados.filter(a => a.pagamento && a.status === 'FILA')
            } else if (filtroAtual === 'aprovados') {
                filtrados = filtrados.filter(a => a.status === 'APROVADO')
            } else if (filtroAtual === 'recusados') {
                filtrados = filtrados.filter(a => a.status === 'RECUSADO')
            }

            if (filtrados.length === 0) {
                document.getElementById('atendimentos').innerHTML = '<div style="text-align: center; padding: 40px;">Nenhum atendimento encontrado</div>'
                return
            }

            let html = '<table><thead><tr><th>ID</th><th>Paciente</th><th>Doença</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead><tbody>'
            for (const a of filtrados) {
                let statusClass = ''
                if (a.status === 'APROVADO') statusClass = 'status-aprovado'
                else if (a.status === 'RECUSADO') statusClass = 'status-recusado'
                else if (a.status === 'FILA') statusClass = 'status-fila'
                else if (a.status === 'INELEGIVEL') statusClass = 'status-inelegivel'

                html += '<tr>' +
                    '<td><code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">' + a.id.substring(0, 8) + '</code></td>' +
                    '<td><strong>' + (a.paciente_nome || 'N/A') + '</strong></td>' +
                    '<td>' + (a.doencas || 'N/A') + '</td>' +
                    '<td><span class="status-badge ' + statusClass + '">' + (a.status || 'PENDENTE') + '</span></td>' +
                    '<td>' + (a.pagamento ? '✅ Pago' : '⏳ Pendente') + '</td>' +
                    html += '<button class="btn btn-info" onclick="verDetalhes(\'' + a.id + '\')">📋 Ver</button>' +
                            '<button class="btn btn-primary" onclick="abrirProntuario(\'' + a.id + '\')">🧠 Prontuário</button>' Ver</button>'
                if (a.status === 'FILA') {
                    html += '<button onclick="aprovarEPrescrever(ID_ATENDIMENTO)">✅ Aprovar e Prescrever</button>'
                            '<button onclick="recusarAtendimento(ID_ATENDIMENTO)">❌ Recusar</button>'
                }
                html += '</td></tr>'
            }
            html += '</tbody></table>'
            document.getElementById('atendimentos').innerHTML = html
        }

        async function verDetalhes(id) {
            try {
                const res = await fetch(API_URL + '/api/atendimento/' + id, {
                    headers: { 'Authorization': 'Bearer ' + token }
                })
                const a = await res.json()
                const detalhes = 
                    '📋 DETALHES DO ATENDIMENTO\\n\\n' +
                    '👤 Paciente: ' + (a.paciente_nome || 'N/A') + '\\n' +
                    '📱 Telefone: ' + (a.paciente_telefone || 'N/A') + '\\n' +
                    '🆔 CPF: ' + (a.paciente_cpf || 'N/A') + '\\n' +
                    '📧 Email: ' + (a.paciente_email || 'N/A') + '\\n' +
                    '🏥 Doença: ' + (a.doencas || 'N/A') + '\\n' +
                    '📊 Status: ' + (a.status || 'PENDENTE') + '\\n' +
                    '💳 Pagamento: ' + (a.pagamento ? 'Pago' : 'Pendente')
                alert(detalhes)
            } catch(e) {
                alert('Erro ao carregar detalhes')
            }
        }

async function aprovarEPrescrever(id) {
    try {
        const res = await fetch(API_URL + '/api/decisao/' + id, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ decisao: 'APROVAR' })
        });

        const result = await res.json();
        if (!result.success) {
            return alert('Erro ao aprovar');
        }

        window.atendimentoAtual = id;

        const prontuarioRes = await fetch(API_URL + '/api/prontuario/' + id, {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        const data = await prontuarioRes.json();

        // Chama a função da Memed passando os dados do prontuário
        await abrirMemed(data);

    } catch (e) {
        console.error(e);
        alert('Erro no processo');
    }
}

async function salvarReceitaBackend(data) {
    await fetch(API_URL + '/api/receita', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
            ...data,
            atendimentoId: window.atendimentoAtual
        })
    });
}

async function abrirMemed(data) {
    // Abrir a plataforma de prescrição
    await MdHub.command.send("plataforma.prescricao", "newPrescription");

    // Enviar dados adicionais do paciente
    await MdHub.command.send("plataforma.prescricao", "setAdditionalData", {
        header: [
            { Nome: data.paciente.nome },
            { CPF: data.paciente.cpf },
            { Doença: data.condicao.doenca }
        ]
    });
    }

// Evento da Memed → salva no backend
MdHub.event.add("prescription:completed", async function (data) {
    console.log("📄 Receita finalizada:", data);
    await salvarReceitaBackend(data);
});

async function recusarAtendimento(id) {
    try {
        await fetch(API_URL + '/api/decisao/' + id, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ decisao: 'RECUSAR' })
        });
        alert('Paciente recusado');
    } catch (e) {
        alert('Erro ao recusar atendimento');
    }
}

// Atualização automática do painel
setInterval(() => {
    const painel = document.getElementById('painel');
    if (painel && painel.style.display !== 'none') {
        carregarDados();
    }
}, 30000);

// ========================
// 🏥 PUBLIC PAGES
// ========================

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '4.1',
    service: 'Doctor Prescreve'
  })
})

app.get('/success', (req, res) => {
  res.send(`<html><body>
    <h1>✅ Pagamento Confirmado!</h1>
    <a href="/painel-medico">Voltar</a>
  </body></html>`)
})

app.get('/cancel', (req, res) => {
  res.send(`<html><body>
    <h1>❌ Pagamento Cancelado</h1>
    <a href="/">Voltar</a>
  </body></html>`)
})

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '4.1.0',
    servico: 'Doctor Prescreve Backend'
  })
})

// ========================
// 📄 SALVAR RECEITA
// ========================
app.post('/api/receita', auth, async (req, res) => {
  try {
    const receita = req.body

    const id = receita.atendimentoId || crypto.randomUUID()
    const file = `data/receita_${id}.json`

    fs.writeFileSync(file, JSON.stringify(receita, null, 2))

    const at = await db.buscarAtendimentoPorId(id)

    const telefone = at ? decrypt(at.paciente_telefone) : null
    const nome = at ? decrypt(at.paciente_nome) : ''

    if (telefone && receita.pdfUrl) {
      await enviarWhatsAppOficial(
        telefone,
        `📄 Olá ${nome}, sua receita está pronta:\n${receita.pdfUrl}`
      )
    }

    console.log('📄 Receita salva:', id)

    res.json({ success: true })

  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// 👇 SUA ROTA DE TESTE
app.get('/teste-whatsapp', async (req, res) => {
  try {
    const numero = process.env.TEST_PHONE_NUMBER || '5511968123900'

    await enviarWhatsAppOficial(
      numero,
      '🚀 Teste WhatsApp funcionando!'
    )

    res.send('OK')
  } catch (e) {
    console.error(e)
    res.status(500).send('Erro')
  }
})

// ========================
// 🚀 STATUS DO SERVIÇO
// ========================
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    versao: '4.1.0',
    servico: 'Doctor Prescreve Backend',
    endpoints: [
      'POST /api/webhook/triagem',
      'GET /api/payment/:id',
      'POST /webhook/stripe',
      'POST /login',
      'GET /painel-medico',
      'GET /healthz'
    ],
    documentacao: 'https://github.com/MMax-Company/doctor-repositorio-central'
  });
});

// ========================
// 🩺 HEALTHCHECK (RAILWAY)
// ========================
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ========================
// 🚀 START SERVER
// ========================
const PORT = process.env.PORT || 3002;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Doctor Prescreve Backend rodando na porta ${PORT}`);
  console.log(`🌐 Healthcheck: http://localhost:${PORT}/healthz`);
});
