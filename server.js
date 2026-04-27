require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const { v4: uuidv4 } = require('uuid')  // <-- IMPORTANTE: npm install uuid
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3002

const BASE_URL = process.env.BASE_URL 
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)

// ========================
// 🔐 VALIDAÇÃO
// ========================
;['ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'MEDICO_PASS'].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ ERRO: ${v} não definida em .env`)
    process.exit(1)
  }
})

// ========================
// 🔐 CRIPTOGRAFIA (ACEITA AMBOS OS FORMATOS)
// ========================
const encryptionKeyHex = process.env.ENCRYPTION_KEY
let key

// Tenta interpretar como hexadecimal primeiro
if (/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
  key = Buffer.from(encryptionKeyHex, 'hex')
  console.log('✅ ENCRYPTION_KEY válida (formato hexadecimal)')
} else {
  // Fallback: deriva uma chave de 32 bytes do texto fornecido
  console.warn('⚠️ ENCRYPTION_KEY não está em formato hexadecimal, usando hash SHA-256')
  key = crypto.createHash('sha256').update(encryptionKeyHex).digest()
  console.log('✅ Chave derivada com sucesso (32 bytes)')
}

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
    if (!fs.existsSync(DB_DIR)) return []
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

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero, msg) {
  if (!numero || !process.env.ULTRAMSG_INSTANCE || !process.env.ULTRAMSG_TOKEN) {
    console.log('⚠️ WhatsApp não configurado')
    return
  }

  const tel = numero.replace(/\D/g, '')
  if (tel.length < 11) {
    console.warn('⚠️ Número inválido para WhatsApp:', numero)
    return
  }

  try {
    await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token: process.env.ULTRAMSG_TOKEN,
        to: `+55${tel}`,
        body: msg
      }),
      { timeout: 10000 }
    )
    console.log(`✅ WhatsApp enviado para ${tel}`)
  } catch(e) {
    console.error("❌ WhatsApp erro:", e.message)
  }
}

// MIDDLEWARES (CSP CORRIGIDO)
// ========================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
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

    const id = uuidv4()
    const texto = triagem.doencas.toLowerCase()
    
    const doencasElegiveis = ['has', 'diabetes', 'hipertensão', 'pressão', 'hipotireoidismo', 'dislipidemia']
    const elegivel = doencasElegiveis.some(d => texto.includes(d))

    const atendimento = {
      id,
      paciente_nome: encrypt(paciente.nome),
      paciente_telefone: encrypt(paciente.telefone || ''),
      paciente_cpf: encrypt(paciente.cpf || ''),
      paciente_email: encrypt(paciente.email || ''),
      doencas: encrypt(texto),
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
          },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success`,
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

          const msg = `✅ Pagamento confirmado!\n\n👨‍⚕️ Seu atendimento #${atendimentoId.substring(0, 8)} entrou na fila de avaliação.\n\n⏳ Você receberá a resposta em até 24h úteis.`
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
// 📋 ROTAS PROTEGIDAS
// ========================

app.get('/api/atendimentos', auth, async (req, res) => {
  try {
    const list = await db.getAtendimentos()
    const descriptografados = list.map(a => ({
      ...a,
      paciente_nome: decrypt(a.paciente_nome),
      paciente_telefone: decrypt(a.paciente_telefone),
      paciente_cpf: decrypt(a.paciente_cpf),
      paciente_email: decrypt(a.paciente_email),
      doencas: decrypt(a.doencas)
    }))
    res.json(descriptografados)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/estatisticas', auth, async (req, res) => {
  try {
    const a = await db.getAtendimentos()
    res.json({
      total: a.length,
      elegiveis: a.filter(x => x.elegivel).length,
      pagos: a.filter(x => x.pagamento).length,
      naFila: a.filter(x => x.pagamento && x.status === 'FILA').length,
      aprovados: a.filter(x => x.status === 'APROVADO').length,
      recusados: a.filter(x => x.status === 'RECUSADO').length
    })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// NOVA ROTA: Buscar atendimento específico
app.get('/api/atendimento/:id', auth, async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    res.json({
      ...at,
      paciente_nome: decrypt(at.paciente_nome),
      paciente_telefone: decrypt(at.paciente_telefone),
      paciente_cpf: decrypt(at.paciente_cpf),
      paciente_email: decrypt(at.paciente_email),
      doencas: decrypt(at.doencas)
    })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/decisao/:id', auth, async (req, res) => {
  try {
    const { decisao } = req.body
    const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
    
    await db.atualizarStatus(req.params.id, novoStatus)

    const at = await db.buscarAtendimentoPorId(req.params.id)
    const telefone = decrypt(at.paciente_telefone)
    const nome = decrypt(at.paciente_nome)

    if (decisao === 'APROVAR') {
      const msg = `✅ Ótimas notícias, ${nome}!\n\n🎉 Sua receita foi APROVADA!\n\n📋 Número: ${req.params.id.substring(0, 8)}\n\n💊 A receita é válida por 30 dias.`
      await enviarWhatsApp(telefone, msg)
    } else {
      const msg = `❌ Infelizmente, sua receita foi RECUSADA.\n\n📋 Número: ${req.params.id.substring(0, 8)}\n\n🏥 Procure um atendimento presencial.`
      await enviarWhatsApp(telefone, msg)
    }

    res.json({ success: true, novoStatus })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🏥 PAINEL MÉDICO (SEM INLINE EVENT HANDLERS)
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
        .login-card h2 { color: #1a6b8a; margin-bottom: 24px; text-align: center; }
        .login-card input {
            width: 100%;
            padding: 12px;
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
        .error-msg { color: red; text-align: center; margin-top: 10px; display: none; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; display: none; }
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
        .logout-btn {
            background: rgba(255,255,255,0.2);
            border: 1px solid white;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            color: white;
        }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; border-radius: 16px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .stat-number { font-size: 36px; font-weight: bold; color: #1a6b8a; }
        .filtros { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .filtro-btn {
            background: #e9ecef;
            border: none;
            padding: 10px 24px;
            border-radius: 30px;
            cursor: pointer;
        }
        .filtro-btn.ativo { background: #1a6b8a; color: white; }
        .table-container { background: white; border-radius: 16px; overflow-x: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
        th { background: #f8f9fa; }
        .status-badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .status-aprovado { background: #d4edda; color: #155724; }
        .status-recusado { background: #f8d7da; color: #721c24; }
        .status-fila { background: #fff3cd; color: #856404; }
        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            margin: 2px;
        }
        .btn-primary { background: #28a745; color: white; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-info { background: #17a2b8; color: white; }
    </style>
</head>
<body>

<div id="login" class="login-container">
    <div class="login-card">
        <h2>🔐 Painel Médico</h2>
        <input type="password" id="senha" placeholder="Digite sua senha">
        <button id="btnLogin">Entrar</button>
        <div id="erroMsg" class="error-msg">❌ Senha incorreta!</div>
    </div>
</div>

<div id="painel">
    <div class="container">
        <div class="painel-header">
            <h1>📊 Doctor Prescreve - Painel Médico</h1>
            <button id="btnLogout" class="logout-btn">Sair</button>
        </div>
        <div class="stats-grid" id="stats">⏳ Carregando...</div>
        <div class="filtros">
            <button data-filtro="todos" class="filtro-btn ativo">Todos</button>
            <button data-filtro="fila" class="filtro-btn">Na Fila</button>
            <button data-filtro="aprovados" class="filtro-btn">Aprovados</button>
            <button data-filtro="recusados" class="filtro-btn">Recusados</button>
        </div>
        <div class="table-container" id="atendimentos">⏳ Carregando...</div>
    </div>
</div>

<script>
    let token = '';
    let dadosAtendimentos = [];
    let filtroAtual = 'todos';

    // Elementos DOM
    const loginDiv = document.getElementById('login');
    const painelDiv = document.getElementById('painel');
    const senhaInput = document.getElementById('senha');
    const btnLogin = document.getElementById('btnLogin');
    const btnLogout = document.getElementById('btnLogout');
    const erroMsg = document.getElementById('erroMsg');
    const statsDiv = document.getElementById('stats');
    const atendimentosDiv = document.getElementById('atendimentos');

    // Função de login
    async function fazerLogin() {
        const senha = senhaInput.value;
        if (!senha) return alert('Digite a senha!');

        try {
            const res = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senha })
            });
            const data = await res.json();
            if (data.token) {
                token = data.token;
                loginDiv.style.display = 'none';
                painelDiv.style.display = 'block';
                carregarDados();
                erroMsg.style.display = 'none';
            } else {
                erroMsg.style.display = 'block';
            }
        } catch(e) {
            alert('Erro ao fazer login: ' + e.message);
        }
    }

    // Logout
    function logout() {
        token = '';
        loginDiv.style.display = 'flex';
        painelDiv.style.display = 'none';
        senhaInput.value = '';
    }

    // Carregar dados
    async function carregarDados() {
        await carregarEstatisticas();
        await carregarAtendimentos();
    }

    async function carregarEstatisticas() {
        try {
            const res = await fetch('/api/estatisticas', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const stats = await res.json();
            statsDiv.innerHTML = 
                '<div class="stat-card"><div class="stat-number">' + (stats.total || 0) + '</div><div>Total</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.naFila || 0) + '</div><div>Na Fila</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.aprovados || 0) + '</div><div>Aprovados</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.recusados || 0) + '</div><div>Recusados</div></div>';
        } catch(e) { console.error(e); }
    }

    async function carregarAtendimentos() {
        try {
            const res = await fetch('/api/atendimentos', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            dadosAtendimentos = await res.json();
            renderizarAtendimentos();
        } catch(e) { console.error(e); }
    }

    function renderizarAtendimentos() {
        let filtrados = [...dadosAtendimentos];
        if (filtroAtual === 'fila') {
            filtrados = filtrados.filter(a => a.pagamento && a.status === 'FILA');
        } else if (filtroAtual === 'aprovados') {
            filtrados = filtrados.filter(a => a.status === 'APROVADO');
        } else if (filtroAtual === 'recusados') {
            filtrados = filtrados.filter(a => a.status === 'RECUSADO');
        }

        if (filtrados.length === 0) {
            atendimentosDiv.innerHTML = '<div style="text-align:center;padding:40px">Nenhum atendimento encontrado</div>';
            return;
        }

        let html = '<table><thead><tr><th>ID</th><th>Paciente</th><th>Doença</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead><tbody>';
        for (const a of filtrados) {
            let statusClass = '';
            if (a.status === 'APROVADO') statusClass = 'status-aprovado';
            else if (a.status === 'RECUSADO') statusClass = 'status-recusado';
            else if (a.status === 'FILA') statusClass = 'status-fila';
            
            html += '<tr>' +
                '<td>' + a.id.substring(0, 8) + '</td>' +
                '<td>' + (a.paciente_nome || 'N/A') + '</tr>' +
                '<td>' + (a.doencas || 'N/A') + '</td>' +
                '<td><span class="status-badge ' + statusClass + '">' + (a.status || 'PENDENTE') + '</span></td>' +
                '<td>' + (a.pagamento ? '✅ Pago' : '⏳ Pendente') + '</td>' +
                '<td>' +
                    '<button class="btn btn-info" data-id="' + a.id + '" data-acao="ver">Ver</button>';
            if (a.status === 'FILA') {
                html += '<button class="btn btn-primary" data-id="' + a.id + '" data-acao="aprovar">Aprovar</button>' +
                        '<button class="btn btn-danger" data-id="' + a.id + '" data-acao="recusar">Recusar</button>';
            }
            html += '</td></tr>';
        }
        html += '</tbody></table>';
        atendimentosDiv.innerHTML = html;

        // Adicionar event listeners para os botões dinâmicos
        document.querySelectorAll('.btn-info').forEach(btn => {
            btn.addEventListener('click', () => verDetalhes(btn.getAttribute('data-id')));
        });
        document.querySelectorAll('.btn-primary').forEach(btn => {
            btn.addEventListener('click', () => aprovar(btn.getAttribute('data-id')));
        });
        document.querySelectorAll('.btn-danger').forEach(btn => {
            btn.addEventListener('click', () => recusar(btn.getAttribute('data-id')));
        });
    }

    async function verDetalhes(id) {
        try {
            const res = await fetch('/api/atendimento/' + id, {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const a = await res.json();
            alert('📋 DETALHES\\n\\n👤 Paciente: ' + (a.paciente_nome || 'N/A') + 
                  '\\n📱 Telefone: ' + (a.paciente_telefone || 'N/A') +
                  '\\n🆔 CPF: ' + (a.paciente_cpf || 'N/A') +
                  '\\n🏥 Doença: ' + (a.doencas || 'N/A'));
        } catch(e) {
            alert('Erro ao carregar detalhes');
        }
    }

    async function aprovar(id) {
        if (!confirm('Aprovar este paciente?')) return;
        try {
            await fetch('/api/decisao/' + id, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ decisao: 'APROVAR' })
            });
            carregarDados();
        } catch(e) {
            alert('Erro ao aprovar');
        }
    }

    async function recusar(id) {
        if (!confirm('Recusar este paciente?')) return;
        try {
            await fetch('/api/decisao/' + id, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ decisao: 'RECUSAR' })
            });
            carregarDados();
        } catch(e) {
            alert('Erro ao recusar');
        }
    }

    // Event Listeners (sem inline handlers)
    btnLogin.addEventListener('click', fazerLogin);
    btnLogout.addEventListener('click', logout);
    
    senhaInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') fazerLogin();
    });

    // Filtros
    document.querySelectorAll('.filtro-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            filtroAtual = btn.getAttribute('data-filtro');
            document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('ativo'));
            btn.classList.add('ativo');
            renderizarAtendimentos();
        });
    });

    // Auto-refresh a cada 30 segundos
    setInterval(() => {
        if (token) carregarDados();
    }, 30000);
</script>
</body>
</html>`)
})

// ========================
// PÁGINAS PÚBLICAS
// ========================
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/success', (req, res) => {
  res.send(`<html><body style="text-align:center;padding:50px"><h1 style="color:green">✅ Pagamento Confirmado!</h1><p>Você receberá a resposta em até 24h.</p><a href="/painel-medico">Voltar</a></body></html>`)
})

app.get('/cancel', (req, res) => {
  res.send(`<html><body style="text-align:center;padding:50px"><h1 style="color:red">❌ Pagamento Cancelado</h1><a href="/painel-medico">Voltar</a></body></html>`)
})

app.get('/', (req, res) => {
  res.json({ service: 'Doctor Prescreve', version: '5.0', endpoints: ['/api/webhook/triagem', '/painel-medico', '/healthz'] })
})

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(50))
  console.log('🚀 Doctor Prescreve Backend v5.0')
  console.log('='.repeat(50))
  console.log(`📡 Porta: ${PORT}`)
  console.log(`🌍 URL: ${BASE_URL}`)
  console.log(`🏥 Painel: ${BASE_URL}/painel-medico`)
  console.log('='.repeat(50))
})

module.exports = app
