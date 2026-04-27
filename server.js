require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const { v4: uuidv4 } = require('uuid')
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
// 🔐 CRIPTOGRAFIA
// ========================
const encryptionKeyHex = process.env.ENCRYPTION_KEY
let key

if (/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
  key = Buffer.from(encryptionKeyHex, 'hex')
  console.log('✅ ENCRYPTION_KEY válida (formato hexadecimal)')
} else {
  console.warn('⚠️ ENCRYPTION_KEY usando hash SHA-256')
  key = crypto.createHash('sha256').update(encryptionKeyHex).digest()
}

function encrypt(text) {
  if (!text) return null
  try {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
  } catch(e) {
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
// 💾 BANCO DE DADOS
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
    }
  },

  async atualizarStatusPagamento(id, pago, status) {
    const at = await this.buscarAtendimentoPorId(id)
    if (at) {
      at.pagamento = pago
      at.status = status
      at.pago_em = new Date().toISOString()
      await this.salvarAtendimento(at)
    }
  },

  async adicionarReceita(id, receita) {
    const at = await this.buscarAtendimentoPorId(id)
    if (at) {
      at.receita = receita
      at.receita_em = new Date().toISOString()
      await this.salvarAtendimento(at)
    }
  }
}

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero, msg) {
  if (!numero || !process.env.ULTRAMSG_INSTANCE || !process.env.ULTRAMSG_TOKEN) return
  const tel = numero.replace(/\D/g, '')
  if (tel.length < 11) return
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
  } catch(e) {}
}

// ========================
// 🔗 MEMED (Prescrição Digital) - FUNÇÃO ADICIONADA
// ========================
async function enviarPrescricaoMemed(paciente, medicamentos, receitaId) {
  if (!process.env.MEMED_API_KEY) {
    console.log('⚠️ Memed não configurado')
    return null
  }
  
  try {
    const payload = {
      patient: {
        name: paciente.nome,
        cpf: paciente.cpf,
        birth_date: paciente.nascimento || '1990-01-01',
        phone: paciente.telefone
      },
      prescription: {
        id: receitaId,
        date: new Date().toISOString(),
        items: medicamentos.map(med => ({
          name: med.nome,
          dosage: med.dosagem,
          duration: med.duracao,
          quantity: med.quantidade,
          instructions: med.instrucoes || 'Tomar conforme orientação médica'
        }))
      },
      doctor: {
        name: `${process.env.MEDICO_NOME || 'Dr'} ${process.env.MEDICO_SOBRENOME || 'Medico'}`,
        council: process.env.MEDICO_CONSELHO || 'CRM',
        number: process.env.MEDICO_NUMERO || '123456',
        uf: process.env.MEDICO_UF || 'SP'
      }
    }
    
    const response = await axios.post(
      `${process.env.MEMED_API_URL || 'https://integrations.api.memed.com.br/v1'}/prescriptions`,
      payload,
      {
        headers: {
          'X-API-KEY': process.env.MEMED_API_KEY,
          'X-SECRET-KEY': process.env.MEMED_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    )
    
    console.log(`✅ Prescrição enviada ao Memed: ${receitaId}`)
    return response.data
  } catch(e) {
    console.error('❌ Memed erro:', e.response?.data || e.message)
    return null
  }
}

// ========================
// 🛡️ MIDDLEWARES (SEM CSP - PARA EVITAR BLOQUEIOS)
// ========================
// Helmet desabilitado completamente para permitir inline handlers
// app.use(helmet())  
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
    return res.status(401).json({ error: 'Não autorizado' })
  }
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({ error: 'Dados inválidos' })
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
      await enviarWhatsApp(paciente.telefone, `✅ Olá ${paciente.nome}! Sua triagem foi aprovada! Link: ${url}`)
    } else {
      await enviarWhatsApp(paciente.telefone, '❌ Não elegível para teleconsulta.')
    }

    res.json({ success: true, id, elegivel })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) return res.status(404).json({ error: 'Não encontrado' })

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: { atendimentoId: req.params.id },
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: { name: 'Consulta Médica' },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success`,
      cancel_url: `${BASE_URL}/cancel`
    })
    res.json({ url: session.url })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 🔥 STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.json({ received: true })

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const atendimentoId = session.metadata?.atendimentoId
      if (atendimentoId) {
        await db.atualizarStatusPagamento(atendimentoId, true, 'FILA')
        const at = await db.buscarAtendimentoPorId(atendimentoId)
        const telefone = decrypt(at.paciente_telefone)
        await enviarWhatsApp(telefone, '✅ Pagamento confirmado! Você está na fila.')
      }
    }
    res.json({ received: true })
  } catch(e) {
    res.status(400).send(`Webhook Error: ${e.message}`)
  }
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login', (req, res) => {
  if (req.body.senha !== process.env.MEDICO_PASS) {
    return res.status(401).json({ error: 'Senha inválida' })
  }
  res.json({ token: gerarToken() })
})

// ========================
// 📋 ROTAS PROTEGIDAS
// ========================
app.get('/api/atendimentos', auth, async (req, res) => {
  const list = await db.getAtendimentos()
  res.json(list.map(a => ({ ...a, paciente_nome: decrypt(a.paciente_nome), paciente_telefone: decrypt(a.paciente_telefone), doencas: decrypt(a.doencas) })))
})

app.get('/api/estatisticas', auth, async (req, res) => {
  const a = await db.getAtendimentos()
  res.json({
    total: a.length,
    naFila: a.filter(x => x.pagamento && x.status === 'FILA').length,
    aprovados: a.filter(x => x.status === 'APROVADO').length,
    recusados: a.filter(x => x.status === 'RECUSADO').length
  })
})

app.get('/api/atendimento/:id', auth, async (req, res) => {
  const at = await db.buscarAtendimentoPorId(req.params.id)
  if (!at) return res.status(404).json({ error: 'Não encontrado' })
  res.json({ ...at, paciente_nome: decrypt(at.paciente_nome), paciente_telefone: decrypt(at.paciente_telefone), doencas: decrypt(at.doencas) })
})

// ROTA PARA ADICIONAR RECEITA (NOVA)
app.post('/api/receita/:id', auth, async (req, res) => {
  try {
    const { medicamentos } = req.body
    const at = await db.buscarAtendimentoPorId(req.params.id)
    
    if (!at) return res.status(404).json({ error: 'Atendimento não encontrado' })
    
    // Salvar receita no banco
    await db.adicionarReceita(req.params.id, { medicamentos, criado_em: new Date().toISOString() })
    
    // Enviar para Memed se configurado
    const paciente = {
      nome: decrypt(at.paciente_nome),
      cpf: decrypt(at.paciente_cpf),
      telefone: decrypt(at.paciente_telefone)
    }
    
    const resultadoMemed = await enviarPrescricaoMemed(paciente, medicamentos, req.params.id)
    
    // Enviar WhatsApp com link da receita
    const telefone = decrypt(at.paciente_telefone)
    const nome = decrypt(at.paciente_nome)
    const msg = `✅ Olá ${nome}! Sua receita foi gerada com sucesso!\n\n📋 Código: ${req.params.id.substring(0, 8)}\n\n💊 Acesse: ${BASE_URL}/receita/${req.params.id}`
    await enviarWhatsApp(telefone, msg)
    
    res.json({ success: true, memed: !!resultadoMemed })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ROTA PARA VISUALIZAR RECEITA (PÚBLICA)
app.get('/receita/:id', async (req, res) => {
  const at = await db.buscarAtendimentoPorId(req.params.id)
  if (!at || !at.receita) {
    return res.send('<h1>Receita não encontrada</h1>')
  }
  
  const pacienteNome = decrypt(at.paciente_nome)
  const medicamentos = at.receita.medicamentos || []
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Receita Médica</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 40px; background: #f0f2f5; }
            .receita { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
            h1 { color: #1a6b8a; text-align: center; }
            .medicamento { border-bottom: 1px solid #ddd; padding: 15px 0; }
            .assinatura { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center; }
            @media print {
                body { background: white; padding: 0; }
                .receita { box-shadow: none; padding: 20px; }
                button { display: none; }
            }
        </style>
    </head>
    <body>
        <div class="receita">
            <h1>📋 Receita Médica</h1>
            <p><strong>Paciente:</strong> ${pacienteNome}</p>
            <p><strong>Data:</strong> ${new Date(at.receita.criado_em).toLocaleDateString('pt-BR')}</p>
            <p><strong>Válida por:</strong> 30 dias</p>
            <h3>💊 Medicamentos Prescritos:</h3>
            ${medicamentos.map(med => `
                <div class="medicamento">
                    <strong>${med.nome}</strong><br>
                    Dosagem: ${med.dosagem}<br>
                    Duração: ${med.duracao}<br>
                    Quantidade: ${med.quantidade} unidades<br>
                    ${med.instrucoes ? `Instruções: ${med.instrucoes}` : ''}
                </div>
            `).join('')}
            <div class="assinatura">
                <p>_________________________________</p>
                <p>${process.env.MEDICO_NOME || 'Dr'} ${process.env.MEDICO_SOBRENOME || 'Medico'}</p>
                <p>${process.env.MEDICO_CONSELHO || 'CRM'}/${process.env.MEDICO_UF || 'SP'} ${process.env.MEDICO_NUMERO || '123456'}</p>
            </div>
            <button onclick="window.print()" style="margin-top: 20px; padding: 10px 20px; background: #1a6b8a; color: white; border: none; border-radius: 8px; cursor: pointer;">🖨️ Imprimir Receita</button>
        </div>
    </body>
    </html>
  `)
})

app.post('/api/decisao/:id', auth, async (req, res) => {
  const novoStatus = req.body.decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
  await db.atualizarStatus(req.params.id, novoStatus)
  const at = await db.buscarAtendimentoPorId(req.params.id)
  const telefone = decrypt(at.paciente_telefone)
  const msg = novoStatus === 'APROVADO' ? '✅ Consulta aprovada! Em breve você receberá sua receita.' : '❌ Consulta recusada.'
  await enviarWhatsApp(telefone, msg)
  res.json({ success: true })
})

// ========================
// 🏥 PAINEL MÉDICO COMPLETO (COM MODAL DE RECEITA)
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
        .login-card h2 { color: #1a6b8a; text-align: center; margin-bottom: 20px; }
        .login-card input {
            width: 100%;
            padding: 12px;
            margin-bottom: 20px;
            border: 1px solid #ddd;
            border-radius: 8px;
        }
        .login-card button {
            width: 100%;
            padding: 12px;
            background: #1a6b8a;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; display: none; }
        .header {
            background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%);
            color: white;
            padding: 20px;
            border-radius: 16px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 16px;
            text-align: center;
        }
        .stat-number { font-size: 32px; font-weight: bold; color: #1a6b8a; }
        table {
            width: 100%;
            background: white;
            border-radius: 16px;
            border-collapse: collapse;
            overflow: hidden;
        }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f8f9fa; }
        button { padding: 6px 12px; margin: 2px; border: none; border-radius: 4px; cursor: pointer; }
        .btn-ver { background: #17a2b8; color: white; }
        .btn-aprovar { background: #28a745; color: white; }
        .btn-recusar { background: #dc3545; color: white; }
        .logout-btn { background: rgba(255,255,255,0.2); border: 1px solid white; padding: 8px 16px; border-radius: 8px; cursor: pointer; color: white; }
        
        /* Modal */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }
        .modal-content {
            background: white;
            padding: 30px;
            border-radius: 16px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }
        .modal-content h3 { margin-bottom: 20px; color: #1a6b8a; }
        .modal-content input, .modal-content textarea {
            width: 100%;
            padding: 10px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 8px;
        }
        .med-item {
            background: #f8f9fa;
            padding: 10px;
            margin: 10px 0;
            border-radius: 8px;
        }
        .btn-add { background: #28a745; color: white; padding: 8px 16px; }
        .btn-confirm { background: #1a6b8a; color: white; padding: 12px; width: 100%; margin-top: 10px; }
        .btn-cancel { background: #6c757d; color: white; padding: 8px 16px; margin-top: 10px; }
    </style>
</head>
<body>

<div id="loginArea" class="login-container">
    <div class="login-card">
        <h2>🔐 Painel Médico</h2>
        <input type="password" id="senha" placeholder="Digite sua senha">
        <button id="btnLogin">Entrar</button>
        <div id="erroMsg" style="color:red; text-align:center; margin-top:10px; display:none;">Senha incorreta!</div>
    </div>
</div>

<div id="painelArea" class="container">
    <div class="header">
        <h1>📊 Doctor Prescreve</h1>
        <button id="btnLogout" class="logout-btn">Sair</button>
    </div>
    <div id="stats" class="stats">Carregando...</div>
    <div id="tabela"></div>
</div>

<!-- Modal para Receita -->
<div id="modalReceita" class="modal">
    <div class="modal-content">
        <h3>📋 Prescrição Médica</h3>
        <div id="listaMedicamentos"></div>
        <input type="text" id="medNome" placeholder="Nome do medicamento">
        <input type="text" id="medDosagem" placeholder="Dosagem (ex: 500mg, 1 comprimido)">
        <input type="text" id="medDuracao" placeholder="Duração (ex: 30 dias, uso contínuo)">
        <input type="number" id="medQuantidade" placeholder="Quantidade">
        <textarea id="medInstrucoes" rows="2" placeholder="Instruções (opcional)"></textarea>
        <button class="btn-add" onclick="adicionarMedicamento()">+ Adicionar Medicamento</button>
        <button class="btn-confirm" onclick="confirmarAprovacao()">✅ Confirmar Aprovação</button>
        <button class="btn-cancel" onclick="fecharModal()">Cancelar</button>
    </div>
</div>

<script>
    let token = '';
    let dados = [];
    let atendimentoIdAtual = null;
    let medicamentosTemp = [];

    const loginDiv = document.getElementById('loginArea');
    const painelDiv = document.getElementById('painelArea');
    const btnLogin = document.getElementById('btnLogin');
    const btnLogout = document.getElementById('btnLogout');
    const senhaInput = document.getElementById('senha');
    const erroMsg = document.getElementById('erroMsg');
    const modal = document.getElementById('modalReceita');

    async function fazerLogin() {
        const senha = senhaInput.value;
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
            } else {
                erroMsg.style.display = 'block';
            }
        } catch(e) { alert('Erro: ' + e.message); }
    }

    function logout() {
        token = '';
        loginDiv.style.display = 'flex';
        painelDiv.style.display = 'none';
        senhaInput.value = '';
    }

    async function carregarDados() {
        try {
            const resStats = await fetch('/api/estatisticas', { headers: { 'Authorization': 'Bearer ' + token } });
            const stats = await resStats.json();
            document.getElementById('stats').innerHTML = 
                '<div class="stat-card"><div class="stat-number">' + (stats.total || 0) + '</div><div>Total</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.naFila || 0) + '</div><div>Na Fila</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.aprovados || 0) + '</div><div>Aprovados</div></div>' +
                '<div class="stat-card"><div class="stat-number">' + (stats.recusados || 0) + '</div><div>Recusados</div></div>';

            const resLista = await fetch('/api/atendimentos', { headers: { 'Authorization': 'Bearer ' + token } });
            dados = await resLista.json();
            renderizarTabela();
        } catch(e) { console.error(e); }
    }

    function renderizarTabela() {
        let html = '</table><thead><tr><th>ID</th><th>Paciente</th><th>Doença</th><th>Status</th><th>Ações</th></tr></thead><tbody>';
        for (const a of dados) {
            html += '<tr>' +
                '<td>' + a.id.substring(0,8) + '</td>' +
                '<td>' + (a.paciente_nome || 'N/A') + '</td>' +
                '<td>' + (a.doencas || 'N/A') + '</td>' +
                '<td>' + (a.status || 'PENDENTE') + '</td>' +
                '<td>' +
                    '<button class="btn-ver" onclick="verDetalhes(\'' + a.id + '\')">Ver</button>';
            if (a.status === 'FILA') {
                html += '<button class="btn-aprovar" onclick="abrirModalReceita(\'' + a.id + '\')">Aprovar</button>' +
                        '<button class="btn-recusar" onclick="recusar(\'' + a.id + '\')">Recusar</button>';
            }
            html += '</td></tr>';
        }
        html += '</tbody></table>';
        document.getElementById('tabela').innerHTML = html;
    }

    async function verDetalhes(id) {
        try {
            const res = await fetch('/api/atendimento/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
            const a = await res.json();
            alert('📋 Detalhes\\n\\n👤 Paciente: ' + (a.paciente_nome || 'N/A') + 
                  '\\n📱 Telefone: ' + (a.paciente_telefone || 'N/A') +
                  '\\n🆔 CPF: ' + (a.paciente_cpf || 'N/A') +
                  '\\n🏥 Doença: ' + (a.doencas || 'N/A'));
        } catch(e) { alert('Erro'); }
    }

    function abrirModalReceita(id) {
        atendimentoIdAtual = id;
        medicamentosTemp = [];
        document.getElementById('listaMedicamentos').innerHTML = '';
        document.getElementById('medNome').value = '';
        document.getElementById('medDosagem').value = '';
        document.getElementById('medDuracao').value = '';
        document.getElementById('medQuantidade').value = '';
        document.getElementById('medInstrucoes').value = '';
        modal.style.display = 'flex';
    }

    function adicionarMedicamento() {
        const nome = document.getElementById('medNome').value;
        const dosagem = document.getElementById('medDosagem').value;
        const duracao = document.getElementById('medDuracao').value;
        const quantidade = document.getElementById('medQuantidade').value;
        const instrucoes = document.getElementById('medInstrucoes').value;

        if (!nome || !dosagem || !duracao || !quantidade) {
            alert('Preencha todos os campos do medicamento!');
            return;
        }

        medicamentosTemp.push({ nome, dosagem, duracao, quantidade, instrucoes });
        
        const listaDiv = document.getElementById('listaMedicamentos');
        const medDiv = document.createElement('div');
        medDiv.className = 'med-item';
        medDiv.innerHTML = '<strong>' + nome + '</strong> - ' + dosagem + '<br>' + duracao + ' - ' + quantidade + ' unid.' +
                           '<button onclick="removerMedicamento(this)" style="float:right; background:#dc3545; color:white; padding:2px 8px;">Remover</button>';
        listaDiv.appendChild(medDiv);
        
        // Limpar campos
        document.getElementById('medNome').value = '';
        document.getElementById('medDosagem').value = '';
        document.getElementById('medDuracao').value = '';
        document.getElementById('medQuantidade').value = '';
        document.getElementById('medInstrucoes').value = '';
    }

    function removerMedicamento(btn) {
        const index = Array.from(btn.parentNode.parentNode.children).indexOf(btn.parentNode);
        medicamentosTemp.splice(index, 1);
        btn.parentNode.remove();
    }

    function fecharModal() {
        modal.style.display = 'none';
        atendimentoIdAtual = null;
        medicamentosTemp = [];
    }

    async function confirmarAprovacao() {
        if (medicamentosTemp.length === 0) {
            alert('Adicione pelo menos um medicamento!');
            return;
        }

        if (!confirm('Confirmar aprovação com estes medicamentos?')) return;

        try {
            // Primeiro aprova a consulta
            await fetch('/api/decisao/' + atendimentoIdAtual, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ decisao: 'APROVAR' })
            });
            
            // Depois envia a receita
            await fetch('/api/receita/' + atendimentoIdAtual, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ medicamentos: medicamentosTemp })
            });
            
            alert('✅ Paciente aprovado e receita enviada!');
            fecharModal();
            carregarDados();
        } catch(e) {
            alert('Erro: ' + e.message);
        }
    }

    async function recusar(id) {
        if (!confirm('Recusar este paciente?')) return;
        await fetch('/api/decisao/' + id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ decisao: 'RECUSAR' })
        });
        carregarDados();
    }

    btnLogin.onclick = fazerLogin;
    btnLogout.onclick = logout;
    senhaInput.onkeypress = (e) => { if (e.key === 'Enter') fazerLogin(); };
</script>
</body>
</html>`)
})

// ========================
// PÁGINAS PÚBLICAS
// ========================
app.get('/healthz', (req, res) => res.json({ status: 'ok' }))
app.get('/success', (req, res) => res.send('<h1>✅ Pagamento Confirmado!</h1>'))
app.get('/cancel', (req, res) => res.send('<h1>❌ Pagamento Cancelado</h1>'))
app.get('/', (req, res) => res.json({ service: 'Doctor Prescreve', status: 'online' }))

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🏥 Painel: ${BASE_URL}/painel-medico`)
})

module.exports = app
