require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

const PORT = process.env.PORT || 3002

const BASE_URL = process.env.BASE_URL 
  || (process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
    : `http://localhost:${PORT}`)

app.use(express.json())

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
})

// ========================
// 🔐 VALIDAÇÃO
// ========================
;['ENCRYPTION_KEY','JWT_SECRET','STRIPE_SECRET_KEY','MEDICO_PASS'].forEach(v=>{
  if(!process.env[v]){
    console.error(`❌ ${v} não definida`)
    process.exit(1)
  }
})

const key = Buffer.from(process.env.ENCRYPTION_KEY,'hex')

// ========================
// 🔐 CRIPTO
// ========================
function encrypt(text){
  if(!text) return null
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc',key,iv)
  return iv.toString('hex')+':'+cipher.update(text,'utf8','hex')+cipher.final('hex')
}

function decrypt(text){
  if(!text) return null
  try{
    const [ivHex,data]=text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(ivHex,'hex'))
    return decipher.update(data,'hex','utf8')+decipher.final('utf8')
  }catch{
    return null
  }
}

// ========================
// 💾 DB
// ========================
const fs = require('fs')
const path = require('path')
const DB_DIR='data'
if(!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR,{recursive:true})

const db={
  salvar(at){
    fs.writeFileSync(path.join(DB_DIR,`at_${at.id}.json`),JSON.stringify(at,null,2))
  },
  get(){
    return fs.readdirSync(DB_DIR)
      .filter(f=>f.startsWith('at_'))
      .map(f=>JSON.parse(fs.readFileSync(path.join(DB_DIR,f))))
  },
  find(id){
    const file=path.join(DB_DIR,`at_${id}.json`)
    return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null
  },
  update(id,data){
    const at=this.find(id)
    if(!at) return
    Object.assign(at,data)
    this.salvar(at)
  }
}

// ========================
// 📱 WHATSAPP
// ========================
async function enviarWhatsApp(numero,msg){
  if(!numero || !process.env.ULTRAMSG_INSTANCE) return
  try{
    await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      new URLSearchParams({
        token:process.env.ULTRAMSG_TOKEN,
        to:'+55'+numero.replace(/\D/g,''),
        body:msg
      })
    )
  }catch{}
}

// ========================
// 🛡️ MIDDLEWARE
// ========================
app.use(helmet({
  entSecurityPolicy:{
    directives:{
      defaultSrc:["'self'"],
      scriptSrc:["'self'","'unsafe-inline'","'unsafe-eval'","blob:"],
      scriptSrcAttr:["'unsafe-inline'"],
      workerSrc:["'self'","blob:"],
      styleSrc:["'self'","'unsafe-inline'"],
      imgSrc:["'self'","data:","https:"]
    }
  }
}))

app.use(cors())
app.use(express.json())
app.use('/api/',rateLimit({windowMs:15*60*1000,max:100}))

// ========================
// 🔐 AUTH
// ========================
function gerarToken(){
  return jwt.sign({role:'medico'},process.env.JWT_SECRET)
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
app.post('/api/webhook/triagem',async(req,res)=>{
  const {paciente={},triagem={}}=req.body
  const id=crypto.randomUUID()

  const texto=(triagem.doencas||'').toLowerCase()
  const elegivel=['has','diabetes','hipertensão'].some(d=>texto.includes(d))

  const at={
    id,
    paciente_nome:encrypt(paciente.nome),
    paciente_telefone:encrypt(paciente.telefone),
    doencas:encrypt(texto),
    elegivel,
    status:elegivel?'AGUARDANDO_PAGAMENTO':'INELEGIVEL',
    pagamento:false,
    createdAt:new Date().toISOString()
  }

  db.salvar(at)

  if(!elegivel){
    await enviarWhatsApp(paciente.telefone,'❌ Não elegível para teleconsulta.')
  }

  res.json({id,elegivel})
})

// ========================
// STRIPE CHECKOUT
// ========================
app.get('/api/payment/:id',async(req,res)=>{
  const session=await stripe.checkout.sessions.create({
    mode:'payment',
    payment_method_types:['card'],
    metadata:{id:req.params.id},
    line_items:[{
      price_data:{
        currency:'brl',
        product_data:{name:'Consulta Médica'},
        unit_amount:6990
      },
      quantity:1
    }],
    success_url:BASE_URL+'/success',
    cancel_url:BASE_URL+'/cancel'
  })
  res.json({url:session.url})
})

// ========================
// STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe',express.raw({type:'application/json'}),async(req,res)=>{
  let event
  try{
    event=stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    )
  }catch(err){
    return res.status(400).send('erro webhook')
  }

  if(event.type==='checkout.session.completed'){
    const session=event.data.object
    const id=session.metadata.id

    db.update(id,{
      pagamento:true,
      status:'FILA',
      pagoEm:new Date().toISOString()
    })

    const at=db.find(id)
    const tel=decrypt(at.paciente_telefone)

    await enviarWhatsApp(tel,'💰 Pagamento confirmado. Você está na fila.')
  }

  res.json({received:true})
})

// ========================
// LOGIN
// ========================
app.post('/login',(req,res)=>{
  if(req.body.senha!==process.env.MEDICO_PASS){
    return res.status(401).json({error:'senha inválida'})
  }
  res.json({token:gerarToken()})
})

// ========================
// LISTA
// ========================
app.get('/api/atendimentos',auth,(req,res)=>{
  res.json(db.get().map(a=>({
    ...a,
    paciente_nome:decrypt(a.paciente_nome),
    paciente_telefone:decrypt(a.paciente_telefone),
    doencas:decrypt(a.doencas)
  })))
})

// ========================
// DECISÃO MÉDICA
// ========================
app.post('/api/decisao/:id',auth,async(req,res)=>{
  const status=req.body.decisao==='APROVAR'?'APROVADO':'RECUSADO'
  db.update(req.params.id,{status})

  const at=db.find(req.params.id)
  const tel=decrypt(at.paciente_telefone)

  await enviarWhatsApp(tel, status==='APROVADO'
    ? '✅ Consulta aprovada. Receita será enviada.'
    : '❌ Consulta recusada.')

  res.json({ok:true})
})

// ========================
// ESTATÍSTICAS
// ========================
app.get('/api/estatisticas',auth,(req,res)=>{
  const a=db.get()
  res.json({
    total:a.length,
    fila:a.filter(x=>x.status==='FILA').length,
    aprovados:a.filter(x=>x.status==='APROVADO').length,
    recusados:a.filter(x=>x.status==='RECUSADO').length
  })
})

// ========================
// 🏥 PAINEL
// ========================
app.get('/painel-medico', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<body>

<input id="senha" placeholder="senha">
<button onclick="window.login()">Entrar</button>

<div id="painel" style="display:none">
  <h3>Painel Médico</h3>
  <div id="stats"></div>
  <div id="lista"></div>
</div>

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
  document.getElementById('painel').style.display='block'
  load()
}

async function load(){
  const s = await fetch('/api/estatisticas',{headers:{Authorization:'Bearer '+token}})
  const stats = await s.json()

  document.getElementById('stats').innerHTML =
    'Total:'+stats.total+' | Fila:'+stats.fila+' | Aprovados:'+stats.aprovados

  const res = await fetch('/api/atendimentos',{headers:{Authorization:'Bearer '+token}})
  const dados = await res.json()

  let html=''
  dados.forEach(a=>{
    html += '<div>'+a.id+
      ' <button onclick="window.aprovar(&quot;'+a.id+'&quot;)">Aprovar</button>'+
      ' <button onclick="window.recusar(&quot;'+a.id+'&quot;)">Recusar</button></div>'
  })

  document.getElementById('lista').innerHTML = html
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
</html>`)
})

<input id="senha" placeholder="senha">
<button onclick="window.login()">Entrar</button>

<div id="painel" style="display:none">
<h3>Painel Médico</h3>
<div id="stats"></div>
<div id="lista"></div>
</div>

<script>
let token=''

window.login=async function(){
 const res=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({senha:senha.value})})
 const d=await res.json()
 token=d.token
 painel.style.display='block'
 load()
}

async function load(){
 const s=await fetch('/api/estatisticas',{headers:{Authorization:'Bearer '+token}})
 const stats=await s.json()
 document.getElementById('stats').innerHTML=
 'Total:'+stats.total+' | Fila:'+stats.fila+' | Aprovados:'+stats.aprovados

 const res=await fetch('/api/atendimentos',{headers:{Authorization:'Bearer '+token}})
 const dados=await res.json()

 let html=''
 dados.forEach(a=>{
  html+=\`<div>
  \${a.id.substring(0,6)} - \${a.paciente_nome} - \${a.status}
  <button onclick="window.aprovar('\${a.id}')">Aprovar</button>
  <button onclick="window.recusar('\${a.id}')">Recusar</button>
  </div>\`
 })

 document.getElementById('lista').innerHTML=html
}

window.aprovar=async function(id){
 await fetch('/api/decisao/'+id,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({decisao:'APROVAR'})})
 load()
}

window.recusar=async function(id){
 await fetch('/api/decisao/'+id,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({decisao:'RECUSAR'})})
 load()
}
</script>

</body>
</html>`)
})

// ========================
app.get('/healthz', (req, res) => {
  res.status(200).send('ok')
})

app.listen(PORT,'0.0.0.0',()=>console.log('🚀 rodando',PORT))
