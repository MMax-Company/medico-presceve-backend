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

const BASE_URL = process.env.BASE_URL 
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)

// ========================
// 🔐 VALIDAÇÃO
// ========================
;['ENCRYPTION_KEY','JWT_SECRET','STRIPE_SECRET_KEY'].forEach(v=>{
  if(!process.env[v]){console.error(`❌ ${v} não definida`);process.exit(1)}
})

// ========================
// 🔐 CRIPTOGRAFIA
// ========================
const key = Buffer.from(process.env.ENCRYPTION_KEY)
if(key.length!==32){console.warn('⚠️ ENCRYPTION_KEY com tamanho incorreto, mas continuando...')}

function encrypt(text){
  if(!text) return null
  const iv=crypto.randomBytes(16)
  const cipher=crypto.createCipheriv('aes-256-cbc',key,iv)
  return iv.toString('hex')+':'+cipher.update(text,'utf8','hex')+cipher.final('hex')
}

function decrypt(text){
  if(!text) return null
  try{
    const [ivHex,data]=text.split(':')
    const decipher=crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(ivHex,'hex'))
    return decipher.update(data,'hex','utf8')+decipher.final('utf8')
  }catch(e){return "[Erro ao descriptografar]"}
}

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero,msg){
  if(!numero) return
  const tel=numero.replace(/\D/g,'')
  if(tel.length<11) return

  try{
    await axios.post(`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token:process.env.ULTRAMSG_TOKEN,
        to:`+55${tel}`,
        body:msg
      }),{timeout:10000}
    )
  }catch(e){console.error("WhatsApp erro:",e.message)}
}

// ========================
// 🛡️ MIDDLEWARES
// ========================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
    },
  },
}))
app.use(cors())
app.use(express.json())
app.use('/api/', rateLimit({windowMs:15*60*1000,max:100}))

// ========================
// 🔐 AUTH
// ========================
const gerarToken = () => jwt.sign({role:'medico'}, process.env.JWT_SECRET, {expiresIn:'8h'})

function auth(req,res,next){
  try{
    const token = req.headers.authorization?.split(' ')[1]
    if(!token) throw new Error()
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  }catch{
    return res.status(401).json({error:'Não autorizado'})
  }
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  const {paciente={}, triagem={}} = req.body
  if(!paciente.nome || !triagem.doencas) return res.status(400).json({error:'dados inválidos'})

  const id = crypto.randomUUID()
  const texto = triagem.doencas.toLowerCase()
  const elegivel = ['has','diabetes','hipertensao','pressao'].some(d => texto.includes(d))

  const at = {
    id,
    paciente_nome: encrypt(paciente.nome),
    paciente_telefone: encrypt(paciente.telefone),
    doencas: encrypt(texto),
    elegivel,
    status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
    pagamento: false,
    criado_em: new Date().toISOString()
  }

  await db.salvarAtendimento(at)

  if(elegivel){
    const url = `${BASE_URL}/api/payment/${id}`
    await enviarWhatsApp(paciente.telefone, `Olá ${paciente.nome}! ✅ Atendimento aprovado.\n🔗 Pagamento: ${url}\n💰 R$ 69,90`)
  }

  res.json({id, elegivel, atendimentoId: id})
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/payment/:id', async (req, res) => {
  try{
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if(!at) return res.status(404).json({error:'Atendimento não encontrado'})

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: {atendimentoId: req.params.id},
      line_items: [{
        price_data: {
          currency: 'brl',
          product_data: {name: 'Consulta Assíncrona'},
          unit_amount: 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success`,
      cancel_url: `${BASE_URL}/cancel`
    })
    res.json({url: session.url})
  }catch(error){
    res.status(500).json({error:'Erro ao gerar pagamento'})
  }
})

// ========================
// 🔥 STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe', express.raw({type:'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try{
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  }catch(err){
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if(event.type === 'checkout.session.completed'){
    const session = event.data.object
    const id = session.metadata.atendimentoId

    const at = await db.buscarAtendimentoPorId(id)
    if(at && !at.pagamento){
      await db.atualizarStatusPagamento(id, true, 'FILA')
      if(at.elegivel){
        await memed.emitirReceita(at).catch(e => console.error("Memed erro:", e))
        if(at.paciente_telefone){
          await enviarWhatsApp(decrypt(at.paciente_telefone), `✅ Pagamento confirmado! Seu atendimento #${id} entrou na fila.`)
        }
      }
    }
  }
  res.json({received: true})
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login', (req, res) => {
  if(req.body.senha !== process.env.MEDICO_PASS){
    return res.status(401).json({error:'Senha inválida'})
  }
  res.json({token: gerarToken()})
})

// ========================
// 📋 ROTAS PROTEGIDAS
// ========================
app.get('/api/atendimentos', auth, async (req, res) => {
  const list = await db.getAtendimentos()
  res.json(list.map(a => ({
    ...a,
    paciente_nome: decrypt(a.paciente_nome),
    paciente_telefone: decrypt(a.paciente_telefone),
    doencas: decrypt(a.doencas)
  })))
})

app.get('/api/fila', auth, async (req, res) => {
  const atendimentos = await db.getAtendimentos()
  const fila = atendimentos.filter(a => a.pagamento && a.status === 'FILA')
  res.json({total: fila.length, atendimentos: fila.map(a => ({
    ...a,
    paciente_nome: decrypt(a.paciente_nome)
  }))})
})

app.get('/api/estatisticas', auth, async (req, res) => {
  const a = await db.getAtendimentos()
  res.json({
    total: a.length,
    elegiveis: a.filter(x => x.elegivel).length,
    pagos: a.filter(x => x.pagamento).length,
    naFila: a.filter(x => x.pagamento && x.status === 'FILA').length
  })
})

app.post('/api/decisao/:id', auth, async (req, res) => {
  const novoStatus = req.body.decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
  await db.atualizarStatus(req.params.id, novoStatus)
  res.json({ok: true})
})

app.get('/api/atendimento/:id', auth, async (req, res) => {
  const at = await db.buscarAtendimentoPorId(req.params.id)
  if(!at) return res.status(404).json({error:'Atendimento não encontrado'})
  res.json({
    ...at,
    paciente_nome: decrypt(at.paciente_nome),
    paciente_telefone: decrypt(at.paciente_telefone),
    doencas: decrypt(at.doencas)
  })
})

// ========================
// 🏥 PAINEL MÉDICO (HTML COMPLETO)
// ========================
app.get('/painel-medico', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Painel Médico - Doctor Prescreve</title>
    <meta charset="UTF-8">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f2f5;min-height:100vh}
        .container{max-width:1400px;margin:0 auto;padding:20px}
        .login-container{display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#1a6b8a 0%,#0d4f6b 100%)}
        .login-card{background:white;border-radius:16px;padding:40px;width:100%;max-width:400px}
        .login-card h2{color:#1a6b8a;margin-bottom:24px;text-align:center}
        .login-card input{width:100%;padding:12px 16px;margin-bottom:20px;border:1px solid #ddd;border-radius:8px;font-size:16px}
        .login-card button{width:100%;padding:12px;background:#1a6b8a;color:white;border:none;border-radius:8px;cursor:pointer;font-size:16px}
        .painel-header{background:linear-gradient(135deg,#1a6b8a 0%,#0d4f6b 100%);color:white;padding:20px;border-radius:16px;margin-bottom:30px;display:flex;justify-content:space-between;align-items:center}
        .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:30px}
        .stat-card{background:white;border-radius:16px;padding:20px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
        .stat-number{font-size:36px;font-weight:bold;color:#1a6b8a}
        .filtros{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
        .filtro-btn{background:#e9ecef;border:none;padding:10px 24px;border-radius:30px;cursor:pointer}
        .filtro-btn.ativo{background:#1a6b8a;color:white}
        .table-container{background:white;border-radius:16px;overflow-x:auto}
        table{width:100%;border-collapse:collapse}
        th,td{padding:16px;text-align:left;border-bottom:1px solid #e9ecef}
        th{background:#f8f9fa;font-weight:600}
        .status-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
        .status-aprovado{background:#d4edda;color:#155724}
        .status-recusado{background:#f8d7da;color:#721c24}
        .status-fila{background:#fff3cd;color:#856404}
        .btn{padding:6px 12px;border:none;border-radius:6px;cursor:pointer;margin:2px}
        .btn-primary{background:#28a745;color:white}
        .btn-danger{background:#dc3545;color:white}
        .btn-info{background:#17a2b8;color:white}
        .logout-btn{background:rgba(255,255,255,0.2);border:none;padding:8px 20px;border-radius:8px;color:white;cursor:pointer}
        .error-message{color:#dc3545;margin-top:10px;text-align:center}
    </style>
</head>
<body>
    <div id="login" class="login-container">
        <div class="login-card">
            <h2>🔐 Painel Médico</h2>
            <input type="password" id="senha" placeholder="Digite sua senha" onkeypress="if(event.key==='Enter') login()">
            <button onclick="login()">Entrar</button>
            <div id="erroMsg" class="error-message" style="display:none">Senha incorreta!</div>
        </div>
    </div>

    <div id="painel" style="display:none">
        <div class="container">
            <div class="painel-header">
                <h1>📊 Doctor Prescreve - Painel Médico</h1>
                <button class="logout-btn" onclick="logout()">Sair</button>
            </div>
            <div class="stats-grid" id="stats">Carregando...</div>
            <div class="filtros">
                <button class="filtro-btn ativo" onclick="filtrar('todos')">📋 Todos</button>
                <button class="filtro-btn" onclick="filtrar('fila')">⏳ Na Fila</button>
                <button class="filtro-btn" onclick="filtrar('aprovados')">✅ Aprovados</button>
                <button class="filtro-btn" onclick="filtrar('recusados')">❌ Recusados</button>
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
                const res = await fetch(API_URL + '/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ senha: senha })
                });
                const data = await res.json();
                if (data.token) {
                    token = data.token;
                    document.getElementById('login').style.display = 'none';
                    document.getElementById('painel').style.display = 'block';
                    carregarDados();
                } else {
                    document.getElementById('erroMsg').style.display = 'block';
                }
            } catch(e) {
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
                const res = await fetch(API_URL + '/api/estatisticas', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const stats = await res.json();
                document.getElementById('stats').innerHTML = 
                    '<div class="stat-card"><div class="stat-number">' + (stats.total || 0) + '</div><div>📋 Total</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.elegiveis || 0) + '</div><div>✅ Elegíveis</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.pagos || 0) + '</div><div>💰 Pagos</div></div>' +
                    '<div class="stat-card"><div class="stat-number">' + (stats.naFila || 0) + '</div><div>⏳ Na Fila</div></div>';
            } catch(e) {
                console.error('Erro ao carregar estatísticas:', e);
            }
        }
        
        async function carregarAtendimentos() {
            try {
                const res = await fetch(API_URL + '/api/atendimentos', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                dadosAtendimentos = await res.json();
                renderizarAtendimentos();
            } catch(e) {
                console.error('Erro ao carregar atendimentos:', e);
                document.getElementById('atendimentos').innerHTML = '<div style="text-align:center;padding:40px;">Erro ao carregar atendimentos</div>';
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
                
                html += '<tr>' +
                    '<td><code>' + a.id.substring(0, 8) + '</code></td>' +
                    '<td><strong>' + (a.paciente_nome || 'N/A') + '</strong></td>' +
                    '<td>' + (a.doencas || 'N/A') + '</td>' +
                    '<td><span class="status-badge ' + statusClass + '">' + (a.status || 'PENDENTE') + '</span></td>' +
                    '<td>' + (a.pagamento ? '✅ Pago' : '⏳ Pendente') + '</td>' +
                    '<td><button class="btn btn-info" onclick="verDetalhes(\'' + a.id + '\')">Ver</button>' +
                    (a.status === 'FILA' ? '<button class="btn btn-primary" onclick="aprovar(\'' + a.id + '\')">Aprovar</button><button class="btn btn-danger" onclick="recusar(\'' + a.id + '\')">Recusar</button>' : '') +
                    '</td></tr>';
            }
            html += '</tbody></table>';
            document.getElementById('atendimentos').innerHTML = html;
        }
        
        async function verDetalhes(id) {
            try {
                const res = await fetch(API_URL + '/api/atendimento/' + id, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const a = await res.json();
                alert('📋 DETALHES\\n\\nNome: ' + (a.paciente_nome || 'N/A') + '\\nCPF: ' + (a.paciente_cpf || 'N/A') + '\\nTelefone: ' + (a.paciente_telefone || 'N/A') + '\\nDoença: ' + (a.doencas || 'N/A') + '\\nStatus: ' + (a.status || 'PENDENTE'));
            } catch(e) {
                alert('Erro ao carregar detalhes');
            }
        }
        
        async function aprovar(id) {
            if (!confirm('Aprovar este paciente?')) return;
            try {
                await fetch(API_URL + '/api/decisao/' + id, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ decisao: 'APROVAR' })
                });
                alert('✅ Paciente aprovado!');
                carregarDados();
            } catch(e) {
                alert('Erro ao aprovar');
            }
        }
        
        async function recusar(id) {
            if (!confirm('Recusar este paciente?')) return;
            try {
                await fetch(API_URL + '/api/decisao/' + id, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ decisao: 'RECUSAR' })
                });
                alert('❌ Paciente recusado');
                carregarDados();
            } catch(e) {
                alert('Erro ao recusar');
            }
        }
        
        setInterval(() => {
            if (document.getElementById('painel').style.display !== 'none') carregarDados();
        }, 30000);
    </script>
</body>
</html>`);
});

// ========================
// 🩺 HEALTH
// ========================
app.get('/healthz', (req, res) => res.json({status:'ok', timestamp: new Date().toISOString()}))
app.get('/success', (req, res) => res.send('<h1>✅ Pagamento confirmado!</h1><p>Seu atendimento foi registrado.</p><a href="/painel-medico">Ir para o Painel</a>'))
app.get('/cancel', (req, res) => res.send('<h1>❌ Pagamento cancelado</h1><p>Você pode tentar novamente.</p>'))
app.get('/', (req, res) => res.json({status:'online', versao:'4.0.0', endpoints:['/api/webhook/triagem','/api/payment/:id','/login','/painel-medico']}))

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50))
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🌍 URL: ${BASE_URL}`)
  console.log(`🔐 JWT Auth: ativo`)
  console.log(`🔒 Criptografia: AES-256-CBC ativa`)
  console.log(`🏥 Painel Médico: ${BASE_URL}/painel-medico`)
  console.log('='.repeat(50))
})

module.exports = app
