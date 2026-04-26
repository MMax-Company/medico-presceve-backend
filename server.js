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
app.use('/api/',rateLimit({windowMs:15*60*1000,max:100}))

// ========================
// 🔐 AUTH
// ========================
const gerarToken=()=>jwt.sign({role:'medico'},process.env.JWT_SECRET,{expiresIn:'8h'})

function auth(req,res,next){
  try{
    const token=req.headers.authorization?.split(' ')[1]
    if(!token) throw new Error()
    jwt.verify(token,process.env.JWT_SECRET)
    next()
  }catch{
    return res.status(401).json({error:'Não autorizado'})
  }
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem',async(req,res)=>{
  const {paciente={},triagem={}}=req.body
  if(!paciente.nome||!triagem.doencas)return res.status(400).json({error:'dados inválidos'})

  const id=crypto.randomUUID()
  const texto=triagem.doencas.toLowerCase()
  const elegivel=['has','diabetes','hipertensao','pressao'].some(d=>texto.includes(d))

  const at={
    id,
    paciente_nome:encrypt(paciente.nome),
    paciente_telefone:encrypt(paciente.telefone),
    doencas:encrypt(texto),
    elegivel,
    status:elegivel?'AGUARDANDO_PAGAMENTO':'INELEGIVEL',
    pagamento:false,
    criado_em:new Date().toISOString()
  }

  await db.salvarAtendimento(at)

  if(elegivel){
    const url=`${BASE_URL}/api/payment/${id}`
    await enviarWhatsApp(paciente.telefone,`Olá ${paciente.nome}! ✅ Atendimento aprovado.\n🔗 Pagamento: ${url}\n💰 R$ 69,90`)
  }

  res.json({id,elegivel,atendimentoId:id})
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/payment/:id',async(req,res)=>{
  try{
    const at=await db.buscarAtendimentoPorId(req.params.id)
    if(!at) return res.status(404).json({error:'Atendimento não encontrado'})

    const session=await stripe.checkout.sessions.create({
      mode:'payment',
      payment_method_types:['card'],
      metadata:{atendimentoId:req.params.id},
      line_items:[{
        price_data:{
          currency:'brl',
          product_data:{name:'Consulta Assíncrona'},
          unit_amount:6990
        },
        quantity:1
      }],
      success_url:`${BASE_URL}/success`,
      cancel_url:`${BASE_URL}/cancel`
    })
    res.json({url:session.url})
  }catch(error){
    res.status(500).json({error:'Erro ao gerar pagamento'})
  }
})

// ========================
// 🔥 STRIPE WEBHOOK
// ========================
app.post('/webhook/stripe', express.raw({type:'application/json'}), async (req,res)=>{
  const sig=req.headers['stripe-signature']
  let event

  try{
    event=stripe.webhooks.constructEvent(req.body,sig,process.env.STRIPE_WEBHOOK_SECRET)
  }catch(err){
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if(event.type==='checkout.session.completed'){
    const session=event.data.object
    const id=session.metadata.atendimentoId

    const at=await db.buscarAtendimentoPorId(id)
    if(at&&!at.pagamento){
      await db.atualizarStatusPagamento(id,true,'FILA')
      if(at.elegivel){
        await memed.emitirReceita(at).catch(e=>console.error("Memed erro:",e))
        if(at.paciente_telefone){
          await enviarWhatsApp(decrypt(at.paciente_telefone),`✅ Pagamento confirmado! Seu atendimento #${id} entrou na fila.`)
        }
      }
    }
  }
  res.json({received:true})
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login',(req,res)=>{
  if(req.body.senha!==process.env.MEDICO_PASS){
    return res.status(401).json({error:'Senha inválida'})
  }
  res.json({token:gerarToken()})
})

// ========================
// 📋 ROTAS PROTEGIDAS
// ========================
app.get('/api/atendimentos',auth,async(req,res)=>{
  const list=await db.getAtendimentos()
  res.json(list.map(a=>({
    ...a,
    paciente_nome:decrypt(a.paciente_nome),
    paciente_telefone:decrypt(a.paciente_telefone),
    doencas:decrypt(a.doencas)
  })))
})

app.get('/api/fila',auth,async(req,res)=>{
  const atendimentos=await db.getAtendimentos()
  const fila=atendimentos.filter(a=>a.pagamento&&a.status==='FILA')
  res.json({total:fila.length,atendimentos:fila.map(a=>({
    ...a,
    paciente_nome:decrypt(a.paciente_nome)
  }))})
})

app.get('/api/estatisticas',auth,async(req,res)=>{
  const a=await db.getAtendimentos()
  res.json({
    total:a.length,
    elegiveis:a.filter(x=>x.elegivel).length,
    pagos:a.filter(x=>x.pagamento).length,
    naFila:a.filter(x=>x.pagamento&&x.status==='FILA').length
  })
})

app.post('/api/decisao/:id',auth,async(req,res)=>{
  const novoStatus=req.body.decisao==='APROVAR'?'APROVADO':'RECUSADO'
  await db.atualizarStatus(req.params.id,novoStatus)
  res.json({ok:true})
})

app.get('/api/atendimento/:id',auth,async(req,res)=>{
  const at=await db.buscarAtendimentoPorId(req.params.id)
  if(!at) return res.status(404).json({error:'Atendimento não encontrado'})
  res.json({
    ...at,
    paciente_nome:decrypt(at.paciente_nome),
    paciente_telefone:decrypt(at.paciente_telefone),
    doencas:decrypt(at.doencas)
  })
})

// ========================
// 🩺 HEALTH
// ========================
app.get('/healthz',(req,res)=>res.json({status:'ok',timestamp:new Date().toISOString()}))
app.get('/success',(req,res)=>res.send('<h1>✅ Pagamento confirmado!</h1><p>Seu atendimento foi registrado.</p><a href="/painel-medico">Ir para o Painel</a>'))
app.get('/cancel',(req,res)=>res.send('<h1>❌ Pagamento cancelado</h1><p>Você pode tentar novamente.</p>'))
app.get('/',(req,res)=>res.json({status:'online',versao:'4.0.0',endpoints:['/api/webhook/triagem','/api/payment/:id','/login','/painel-medico']}))

app.listen(PORT,'0.0.0.0',()=>{
  console.log('='.repeat(50))
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🌍 URL: ${BASE_URL}`)
  console.log(`🔐 JWT Auth: ativo`)
  console.log(`🔒 Criptografia: AES-256-CBC ativa`)
  console.log(`🏥 Painel Médico: ${BASE_URL}/painel-medico`)
  console.log('='.repeat(50))
})

module.exports = app