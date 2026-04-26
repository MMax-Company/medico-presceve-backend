require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')

// Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

const db = require('./db')
const memed = require('./memed')

const app = express()
const PORT = process.env.PORT || 3002

// ========================
// 🔐 VALIDAÇÃO OBRIGATÓRIA
// ========================
const requiredEnvVars = ['ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY']
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ ${varName} não definida`)
    process.exit(1)
  }
})

// ========================
// 🔐 CRIPTOGRAFIA SEGURA
// ========================
const algorithm = 'aes-256-cbc'
const key = Buffer.from(process.env.ENCRYPTION_KEY)

function encrypt(text) {
  if (!text) return null
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(text) {
  if (!text) return null
  const parts = text.split(':')
  const iv = Buffer.from(parts[0], 'hex')
  const encryptedText = parts[1]
  const decipher = crypto.createDecipheriv(algorithm, key, iv)
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// ========================
// 🛡️ SEGURANÇA (HELMET + RATE LIMIT)
// ========================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}))

app.use(cors())
app.use(express.json())

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Muitas requisições. Tente novamente mais tarde.'
})
app.use('/api/', limiter)

// ========================
// 🔐 AUTH JWT
// ========================
function gerarToken() {
  return jwt.sign({ role: 'medico' }, process.env.JWT_SECRET, { expiresIn: '8h' })
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Não autorizado' })
  try {
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(403).json({ error: 'Token inválido' })
  }
}

// ========================
// 📱 WHATSAPP (UltraMsg)
// ========================
async function enviarWhatsApp(numero, mensagem, tipo = 'geral') {
  if (!numero) return false
  const telefone = numero.toString().replace(/\D/g, '')
  if (telefone.length < 11) return false

  try {
    await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token: process.env.ULTRAMSG_TOKEN,
        to: `+55${telefone}`,
        body: mensagem,
        priority: '10'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    )
    console.log(`✅ WhatsApp enviado (${tipo}): ${telefone}`)
    return true
  } catch (err) {
    console.error('❌ WhatsApp erro:', err.message)
    return false
  }
}

// ========================
// 🧠 TRIAGEM (WEBHOOK DO TYPEBOT / N8N)
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  try {
    const { paciente = {}, triagem = {} } = req.body

    if (!paciente.nome || !triagem.doencas) {
      return res.status(400).json({ error: 'Dados incompletos: nome e doenças são obrigatórios' })
    }

    const id = crypto.randomUUID()

    // Normalização de doenças
    const doencaTexto = triagem.doencas.toString().toLowerCase()
    const doencasValidas = ['has', 'hipertensao', 'dm', 'diabetes', 'dlp', 'dislipidemia', 'hipotireoidismo']
    const doencaValida = doencasValidas.some(d => doencaTexto.includes(d))
    const sinaisAlerta = triagem.sinaisAlerta === true || triagem.sinaisAlerta === 'true' || triagem.sinaisAlerta === 'SIM'
    const elegivel = doencaValida && !sinaisAlerta

    const atendimento = {
      id,
      paciente_nome: encrypt(paciente.nome),
      paciente_cpf: encrypt(paciente.cpf || ''),
      paciente_telefone: encrypt(paciente.telefone || ''),
      paciente_email: encrypt(paciente.email || ''),
      doencas: doencaTexto,
      elegivel,
      motivo: elegivel ? null : (doencaValida ? 'Sinais de alerta' : 'Doença não atendida'),
      status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
      pagamento: false,
      criado_em: new Date().toISOString()
    }

    await db.salvarAtendimento(atendimento)

    console.log(`📋 Novo atendimento: ${id} - Elegível: ${elegivel}`)

    // WhatsApp se elegível
    if (elegivel && paciente.telefone) {
      const pagamentoUrl = `${process.env.BASE_URL || 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN}/api/payment/${id}`
      await enviarWhatsApp(paciente.telefone, 
        `🏥 *Doctor Prescreve*\n\nOlá ${paciente.nome}! ✅ Atendimento aprovado.\n\n🔗 Pagamento: ${pagamentoUrl}\n💰 Valor: R$ 69,90`,
        'triagem'
      )
    }

    res.json({
      success: true,
      elegivel,
      atendimentoId: id,
      pagamentoUrl: `${process.env.BASE_URL}/api/payment/${id}`
    })

  } catch (error) {
    console.error('Erro na triagem:', error)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ========================
// 💳 CRIAÇÃO DE PAGAMENTO
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
          product_data: { name: 'Consulta Assíncrona' },
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${process.env.BASE_URL}/success`,
      cancel_url: `${process.env.BASE_URL}/cancel`
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error('Erro criar pagamento:', error)
    res.status(500).json({ error: error.message })
  }
})

// ========================
// 🔥 WEBHOOK DO STRIPE (CONFIRMAÇÃO REAL)
// ========================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!webhookSecret) {
    console.log('⚠️ STRIPE_WEBHOOK_SECRET não configurado')
    return res.status(200).json({ received: true })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const id = session.metadata.atendimentoId

    await db.atualizarStatusPagamento(id, true, 'FILA')
    const at = await db.buscarAtendimentoPorId(id)

    // Emitir receita via Memed
    if (at?.elegivel) {
      try {
        await memed.emitirReceita(at)
        console.log(`📄 Receita emitida para ${id}`)
      } catch (error) {
        console.error('Erro ao emitir receita:', error)
      }
    }

    // WhatsApp de confirmação
    if (at?.paciente_telefone) {
      const telefone = decrypt(at.paciente_telefone)
      await enviarWhatsApp(telefone, 
        `✅ *Pagamento Confirmado!*\n\nSeu atendimento ID: ${id} entrou na fila.`,
        'pagamento'
      )
    }
  }

  res.json({ received: true })
})

// ========================
// 🏥 PAINEL MÉDICO (HTML)
// ========================
app.get('/painel-medico', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-br">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Painel Médico - Doctor Prescreve</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; min-height: 100vh; }
            .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
            .login-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%); }
            .login-card { background: white; border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; }
            .login-card h2 { color: #1a6b8a; margin-bottom: 24px; text-align: center; }
            .login-card input { width: 100%; padding: 12px 16px; margin-bottom: 20px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
            .login-card button { width: 100%; padding: 12px; background: #1a6b8a; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; }
            .painel-header { background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%); color: white; padding: 20px; border-radius: 16px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
            .stat-card { background: white; border-radius: 16px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .stat-number { font-size: 36px; font-weight: bold; color: #1a6b8a; }
            .filtros { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
            .filtro-btn { background: #e9ecef; border: none; padding: 10px 24px; border-radius: 30px; cursor: pointer; }
            .filtro-btn.ativo { background: #1a6b8a; color: white; }
            .table-container { background: white; border-radius: 16px; overflow-x: auto; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 16px; text-align: left; border-bottom: 1px solid #e9ecef; }
            th { background: #f8f9fa; font-weight: 600; }
            .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
            .status-aprovado { background: #d4edda; color: #155724; }
            .status-recusado { background: #f8d7da; color: #721c24; }
            .status-fila { background: #fff3cd; color: #856404; }
            .btn { padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; margin: 2px; }
            .btn-primary { background: #28a745; color: white; }
            .btn-danger { background: #dc3545; color: white; }
            .btn-info { background: #17a2b8; color: white; }
            .logout-btn { background: rgba(255,255,255,0.2); border: none; padding: 8px 20px; border-radius: 8px; color: white; cursor: pointer; }
        </style>
    </head>
    <body>
        <div id="login" class="login-container">
            <div class="login-card">
                <h2>🔐 Painel Médico</h2>
                <input type="password" id="senha" placeholder="Digite sua senha" onkeypress="if(event.key==='Enter') login()">
                <button onclick="login()">Entrar</button>
            </div>
        </div>

        <div id="painel" style="display: none;">
            <div class="container">
                <div class="painel-header">
                    <h1>📊 Doctor Prescreve - Painel Médico</h1>
                    <button class="logout-btn" onclick="logout()">Sair</button>
                </div>
                <div class="stats-grid" id="stats">Carregando...</div>
                <div class="filtros">
                    <button class="filtro-btn ativo" onclick="filtrar('todos')">Todos</button>
                    <button class="filtro-btn" onclick="filtrar('fila')">Na Fila</button>
                    <button class="filtro-btn" onclick="filtrar('aprovados')">Aprovados</button>
                    <button class="filtro-btn" onclick="filtrar('recusados')">Recusados</button>
                </div>
                <div class="table-container" id="atendimentos">Carregando...</div>
            </div>
        </div>

        <script>
            const API_URL = window.location.origin;
            let token = '';
            let dadosAtendimentos = [];
            let filtroAtual = 'todos';
            
            async function login() {
                const senha = document.getElementById('senha').value;
                try {
                    const res = await fetch(\`\${API_URL}/login\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ senha })
                    });
                    const data = await res.json();
                    if (data.token) {
                        token = data.token;
                        document.getElementById('login').style.display = 'none';
                        document.getElementById('painel').style.display = 'block';
                        carregarDados();
                    } else {
                        alert('Senha incorreta!');
                    }
                } catch (error) {
                    alert('Erro ao fazer login');
                }
            }
            
            function logout() {
                token = '';
                document.getElementById('login').style.display = 'flex';
                document.getElementById('painel').style.display = 'none';
            }
            
            async function carregarDados() {
                await carregarEstatisticas();
                await carregarAtendimentos();
            }
            
            async function carregarEstatisticas() {
                try {
                    const res = await fetch(\`\${API_URL}/api/estatisticas\`, {
                        headers: { 'Authorization': \`Bearer \${token}\` }
                    });
                    const stats = await res.json();
                    document.getElementById('stats').innerHTML = \`
                        <div class="stat-card"><div class="stat-number">\${stats.total || 0}</div><div>Total</div></div>
                        <div class="stat-card"><div class="stat-number">\${stats.elegiveis || 0}</div><div>Elegíveis</div></div>
                        <div class="stat-card"><div class="stat-number">\${stats.pagos || 0}</div><div>Pagos</div></div>
                        <div class="stat-card"><div class="stat-number">\${stats.naFila || 0}</div><div>Na Fila</div></div>
                    \`;
                } catch (error) {
                    console.error('Erro:', error);
                }
            }
            
            async function carregarAtendimentos() {
                try {
                    const res = await fetch(\`\${API_URL}/api/atendimentos\`, {
                        headers: { 'Authorization': \`Bearer \${token}\` }
                    });
                    dadosAtendimentos = await res.json();
                    renderizarAtendimentos();
                } catch (error) {
                    console.error('Erro:', error);
                }
            }
            
            function filtrar(tipo) {
                filtroAtual = tipo;
                document.querySelectorAll('.filtro-btn').forEach(btn => btn.classList.remove('ativo'));
                event.target.classList.add('ativo');
                renderizarAtendimentos();
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
                    document.getElementById('atendimentos').innerHTML = '<div style="text-align:center;padding:40px;">Nenhum atendimento encontrado.</div>';
                    return;
                }
                
                let html = '<table><thead><tr><th>ID</th><th>Paciente</th><th>Doença</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead><tbody>';
                for (const a of filtrados) {
                    let statusClass = '';
                    if (a.status === 'APROVADO') statusClass = 'status-aprovado';
                    else if (a.status === 'RECUSADO') statusClass = 'status-recusado';
                    else if (a.status === 'FILA') statusClass = 'status-fila';
                    else statusClass = 'status-fila';
                    
                    html += \`
                        <tr>
                            <td>\${a.id.substring(0,8)}</code></td>
                            <td>\${a.paciente_nome || 'N/A'}</td>
                            <td>\${a.doencas || 'N/A'}</td>
                            <td><span class="status-badge \${statusClass}">\${a.status || 'PENDENTE'}</span></td>
                            <td>\${a.pagamento ? '✅ Pago' : '⏳ Pendente'}</td>
                            <td>
                                <button class="btn btn-info" onclick="verDetalhes('\${a.id}')">Ver</button>
                                \${a.status === 'FILA' ? \`
                                    <button class="btn btn-primary" onclick="aprovar('\${a.id}')">Aprovar</button>
                                    <button class="btn btn-danger" onclick="recusar('\${a.id}')">Recusar</button>
                                \` : ''}
                            </td>
                        </tr>
                    \`;
                }
                html += '</tbody></table>';
                document.getElementById('atendimentos').innerHTML = html;
            }
            
            async function verDetalhes(id) {
                try {
                    const res = await fetch(\`\${API_URL}/api/atendimento/\${id}\`, {
                        headers: { 'Authorization': \`Bearer \${token}\` }
                    });
                    const at = await res.json();
                    alert(\`📋 DETALHES\\n\\nNome: \${at.paciente_nome || 'N/A'}\\nCPF: \${at.paciente_cpf || 'N/A'}\\nTelefone: \${at.paciente_telefone || 'N/A'}\\nDoença: \${at.doencas || 'N/A'}\\nStatus: \${at.status || 'PENDENTE'}\`);
                } catch (error) {
                    alert('Erro ao carregar detalhes');
                }
            }
            
            async function aprovar(id) {
                if (confirm('Aprovar este paciente?')) {
                    try {
                        await fetch(\`\${API_URL}/api/decisao/\${id}\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
                            body: JSON.stringify({ decisao: 'APROVAR' })
                        });
                        alert('✅ Paciente aprovado!');
                        carregarDados();
                    } catch (error) {
                        alert('Erro ao aprovar');
                    }
                }
            }
            
            async function recusar(id) {
                if (confirm('Recusar este paciente?')) {
                    try {
                        await fetch(\`\${API_URL}/api/decisao/\${id}\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
                            body: JSON.stringify({ decisao: 'RECUSAR' })
                        });
                        alert('❌ Paciente recusado');
                        carregarDados();
                    } catch (error) {
                        alert('Erro ao recusar');
                    }
                }
            }
            
            setInterval(() => { if (document.getElementById('painel').style.display !== 'none') carregarDados(); }, 30000);
        </script>
    </body>
    </html>
  `);
});

// ========================
// 👨‍⚕️ LOGIN MÉDICO (JWT)
// ========================
app.post('/login', (req, res) => {
  const { senha } = req.body
  if (senha !== process.env.MEDICO_PASS) {
    return res.status(401).json({ error: 'Senha inválida' })
  }
  const token = gerarToken()
  res.json({ token })
})

// ========================
// 📋 FILA (PROTEGIDO)
// ========================
app.get('/api/fila', authMiddleware, async (req, res) => {
  const atendimentos = await db.getAtendimentos()
  const fila = atendimentos.filter(a => a.pagamento && a.status === 'FILA')
  res.json(fila.map(a => ({
    id: a.id,
    paciente_nome: decrypt(a.paciente_nome),
    criado_em: a.criado_em
  })))
})

// ========================
// 📋 TODOS ATENDIMENTOS (PROTEGIDO)
// ========================
app.get('/api/atendimentos', authMiddleware, async (req, res) => {
  const atendimentos = await db.getAtendimentos()
  res.json(atendimentos.map(a => ({
    id: a.id,
    paciente_nome: decrypt(a.paciente_nome),
    elegivel: a.elegivel,
    status: a.status,
    pagamento: a.pagamento,
    criado_em: a.criado_em
  })))
})

// ========================
// 🔍 DETALHES DO ATENDIMENTO (PROTEGIDO)
// ========================
app.get('/api/atendimento/:id', authMiddleware, async (req, res) => {
  const at = await db.buscarAtendimentoPorId(req.params.id)
  if (!at) {
    return res.status(404).json({ error: 'Atendimento não encontrado' })
  }
  res.json({
    ...at,
    paciente_nome: decrypt(at.paciente_nome),
    paciente_cpf: decrypt(at.paciente_cpf),
    paciente_telefone: decrypt(at.paciente_telefone),
    paciente_email: decrypt(at.paciente_email)
  })
})

// ========================
// APROVAR/RECUSAR (PROTEGIDO)
app.post('/api/decisao/:id', authMiddleware, async (req, res) => {
  const { decisao } = req.body
  const { id } = req.params

  await db.atualizarStatus(id, decisao)

  const at = await db.buscarAtendimentoPorId(id)
  if (at?.paciente_telefone) {
    const telefone = decrypt(at.paciente_telefone)
    const mensagem = decisao === 'APROVAR' 
      ? `✅ Seu atendimento foi APROVADO pelo médico! Em breve você receberá sua receita.`
      : `❌ Seu atendimento foi RECUSADO pelo médico.`
    await enviarWhatsApp(telefone, mensagem, 'decisao')
  }

  res.json({ success: true, status: decisao })
})

// ========================
// 📊 ESTATÍSTICAS (PROTEGIDO)
// ========================
app.get('/api/estatisticas', authMiddleware, async (req, res) => {
  const atendimentos = await db.getAtendimentos()
  const stats = {
    total: atendimentos.length,
    elegiveis: atendimentos.filter(a => a.elegivel).length,
    pagos: atendimentos.filter(a => a.pagamento).length,
    naFila: atendimentos.filter(a => a.pagamento && a.status === 'FILA').length,
    aprovados: atendimentos.filter(a => a.status === 'APROVADO').length,
    recusados: atendimentos.filter(a => a.status === 'RECUSADO').length
  }
  res.json(stats)
})

// ========================
// 🏠 HOME
// ========================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '3.0.0',
    endpoints: [
      'POST /api/webhook/triagem',
      'GET /api/payment/:id',
      'POST /login',
      'GET /api/atendimentos (JWT)',
      'GET /api/estatisticas (JWT)',
      'POST /api/decisao/:id (JWT)',
      'GET /api/fila (JWT)',
      'POST /webhook/stripe'
    ]
  })
})

// ========================
// 🩺 HEALTH CHECK
// ========================
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ========================
// ❌ CANCEL
// ========================
app.get('/cancel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Pagamento Cancelado</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>❌ Pagamento Cancelado</h1>
        <p>Nenhum valor foi cobrado. Você pode tentar novamente.</p>
      </body>
    </html>
  `)
})

// ========================
// ✅ SUCCESS (REDIRECIONAMENTO)
// ========================
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Pagamento Confirmado</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>✅ Pagamento Confirmado!</h1>
        <p>Seu atendimento foi registrado. Em breve sua receita será emitida.</p>
      </body>
    </html>
  `)
})

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50))
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🔐 JWT Auth: ativo`)
  console.log(`🔒 Criptografia: AES-256-CBC ativa`)
  console.log(`📱 WhatsApp: ${process.env.ULTRAMSG_INSTANCE ? '✅' : '❌'}`)
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`)
  console.log(`🏥 Health: /healthz`)
  console.log('='.repeat(50))
})

module.exports = app