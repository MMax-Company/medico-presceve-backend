require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy')

const app = express()
const PORT = process.env.PORT || 3002

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
// 🔐 CRIPTOGRAFIA
// ========================
const encryptionKeyHex = process.env.ENCRYPTION_KEY

if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
  console.error('❌ ENCRYPTION_KEY inválida (64 hex)')
  process.exit(1)
}

const key = Buffer.from(encryptionKeyHex, 'hex')

function encrypt(text) {
  if (!text) return null
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  if (!text) return null
  try {
    const [ivHex, data] = text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch {
    return '[erro]'
  }
}

// ========================
// 💾 DB
// ========================
const fs = require('fs')
const path = require('path')
const DB_DIR = 'data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = {
  async salvarAtendimento(at) {
    fs.writeFileSync(path.join(DB_DIR, `atendimento_${at.id}.json`), JSON.stringify(at, null, 2))
  },
  async buscarAtendimentoPorId(id) {
    const file = path.join(DB_DIR, `atendimento_${id}.json`)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null
  },
  async getAtendimentos() {
    return fs.readdirSync(DB_DIR)
      .filter(f => f.startsWith('atendimento_'))
      .map(f => JSON.parse(fs.readFileSync(path.join(DB_DIR, f))))
  },
  async atualizarStatus(id, status) {
    const at = await this.buscarAtendimentoPorId(id)
    if (!at) return
    at.status = status
    await this.salvarAtendimento(at)
  },
  async atualizarStatusPagamento(id, pago, status) {
    const at = await this.buscarAtendimentoPorId(id)
    if (!at) return
    at.pagamento = pago
    at.status = status
    await this.salvarAtendimento(at)
  }
}

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero, msg) {
  if (!numero || !process.env.ULTRAMSG_INSTANCE) return
  try {
    await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token: process.env.ULTRAMSG_TOKEN,
        to: '+55' + numero.replace(/\D/g, ''),
        body: msg
      })
    )
  } catch {}
}

// ========================
// 🛡️ MIDDLEWARE
// ========================
app.use(helmet({
  contentSecurityPolicy:{
    directives:{
      defaultSrc:["'self'"],
      scriptSrc:["'self'","'unsafe-inline'","'unsafe-eval'"],
      scriptSrcAttr:["'unsafe-inline'"],
      styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      fontSrc:["'self'","https://fonts.gstatic.com","data:"],
      imgSrc:["'self'","data:","https:"]
    }
  }
}))

app.use(cors())
app.use(express.json())
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))

// ========================
// 🔐 AUTH
// ========================
function gerarToken(){
  return jwt.sign({ role:'medico' }, process.env.JWT_SECRET)
}

function auth(req,res,next){
  try{
    const token=req.headers.authorization?.split(' ')[1]
    jwt.verify(token,process.env.JWT_SECRET)
    next()
  }catch{
    res.status(401).json({error:'não autorizado'})
  }
}

// ========================
// TRIAGEM
// ========================
app.post('/api/webhook/triagem', async (req,res)=>{
  const { paciente={}, triagem={} } = req.body
  const id = crypto.randomUUID()

  const texto = (triagem.doencas || '').toLowerCase()
  const elegivel = ['has','diabetes','hipertensão'].some(d=>texto.includes(d))

  const at={
    id,
    paciente_nome: encrypt(paciente.nome),
    paciente_telefone: encrypt(paciente.telefone),
    doencas: encrypt(texto),
    elegivel,
    status: elegivel ? 'AGUARDANDO_PAGAMENTO':'INELEGIVEL',
    pagamento:false
  }

  await db.salvarAtendimento(at)
  res.json({ id, elegivel })
})

// ========================
// STRIPE
// ========================
app.get('/api/payment/:id', async (req,res)=>{
  const session = await stripe.checkout.sessions.create({
    mode:'payment',
    payment_method_types:['card'],
    metadata:{ atendimentoId:req.params.id },
    line_items:[{
      price_data:{ currency:'brl', product_data:{ name:'Consulta' }, unit_amount:6990 },
      quantity:1
    }],
    success_url: BASE_URL + '/success',
    cancel_url: BASE_URL + '/cancel'
  })
  res.json({ url:session.url })
})

app.post('/webhook/stripe', express.raw({ type:'application/json' }), async (req,res)=>{
  res.json({ ok:true })
})

// ========================
// LOGIN
// ========================
app.post('/login',(req,res)=>{
  if(req.body.senha!==process.env.MEDICO_PASS){
    return res.status(401).json({error:'senha inválida'})
  }
  res.json({ token: gerarToken() })
})

// ========================
// ROTAS
// ========================
app.get('/api/atendimentos', auth, async (req,res)=>{
  const list = await db.getAtendimentos()
  res.json(list.map(a=>({
    ...a,
    paciente_nome: decrypt(a.paciente_nome),
    paciente_telefone: decrypt(a.paciente_telefone),
    doencas: decrypt(a.doencas)
  })))
})

app.post('/api/decisao/:id', auth, async (req,res)=>{
  const status = req.body.decisao==='APROVAR'?'APROVADO':'RECUSADO'
  await db.atualizarStatus(req.params.id,status)
  res.json({ success:true })
})

// ========================
// 🏥 PAINEL CORRIGIDO
// ========================
app.get('/painel-medico',(req,res)=>{
res.send(`
<html>
<body>
<input id="senha">
<button onclick="window.login()">Login</button>
<div id="app"></div>

<script>
let token=''

window.login = async function(){
  const res = await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({senha:document.getElementById('senha').value})
  })
  const d = await res.json()
  token = d.token
  load()
}

async function load(){
  const res = await fetch('/api/atendimentos',{headers:{Authorization:'Bearer '+token}})
  const dados = await res.json()

  let html=''
  dados.forEach(a=>{
    html += '<div>'+a.id+
      ' <button onclick="window.verDetalhes(&quot;'+a.id+'&quot;)">Ver</button>'+
      ' <button onclick="window.aprovar(&quot;'+a.id+'&quot;)">Aprovar</button>'+
      ' <button onclick="window.recusar(&quot;'+a.id+'&quot;)">Recusar</button></div>'
  })

  document.getElementById('app').innerHTML = html
}

window.verDetalhes = async function(id){
  alert(id)
}

window.aprovar = async function(id){
  await fetch('/api/decisao/'+id,{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({decisao:'APROVAR'})
  })
  load()
}

window.recusar = async function(id){
  await fetch('/api/decisao/'+id,{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({decisao:'RECUSAR'})
  })
  load()
}
</script>
</body>
</html>
`)
})

// ========================
app.get('/healthz',(req,res)=>res.status(200).send('ok'))

app.listen(PORT,'0.0.0.0',()=>console.log('rodando',PORT))
