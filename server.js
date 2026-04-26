require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')

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
if(key.length!==32){console.error('❌ ENCRYPTION_KEY inválida');process.exit(1)}

function encrypt(text){
  if(!text) return null
  const iv=crypto.randomBytes(16)
  const cipher=crypto.createCipheriv('aes-256-cbc',key,iv)
  return iv.toString('hex')+':'+cipher.update(text,'utf8','hex')+cipher.final('hex')
}

function decrypt(text){
  if(!text) return null
  const [ivHex,data]=text.split(':')
  const decipher=crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(ivHex,'hex'))
  return decipher.update(data,'hex','utf8')+decipher.final('utf8')
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
      })
    )
  }catch(e){console.error(e)}
}

// ========================
// 🛡️ MIDDLEWARES (COM CSP COMPLETO)
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
    jwt.verify(token,process.env.JWT_SECRET)
    next()
  }catch{return res.status(401).json({error:'Não autorizado'})}
}

// ========================
// 🧠 TRIAGEM
// ========================
app.post('/api/webhook/triagem',async(req,res)=>{
  const {paciente={},triagem={}}=req.body
  if(!paciente.nome||!triagem.doencas)return res.status(400).json({error:'dados inválidos'})

  const id=crypto.randomUUID()
  const texto=triagem.doencas.toLowerCase()
  const elegivel=['has','diabetes','hipertensao'].some(d=>texto.includes(d))

  const at={
    id,
    paciente_nome:encrypt(paciente.nome),
    paciente_telefone:encrypt(paciente.telefone),
    doencas:texto,
    elegivel,
    status:elegivel?'AGUARDANDO_PAGAMENTO':'INELEGIVEL',
    pagamento:false,
    criado_em:new Date().toISOString()
  }

  await db.salvarAtendimento(at)

  if(elegivel){
    const url=`${BASE_URL}/api/payment/${id}`
    await enviarWhatsApp(paciente.telefone,`💳 Pagamento: ${url}`)
  }

  res.json({id,elegivel,atendimentoId:id})
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/payment/:id',async(req,res)=>{
  const session=await stripe.checkout.sessions.create({
    mode:'payment',
    metadata:{atendimentoId:req.params.id},
    line_items:[{
      price_data:{currency:'brl',product_data:{name:'Consulta'},unit_amount:6990},
      quantity:1
    }],
    success_url:`${BASE_URL}/success`,
    cancel_url:`${BASE_URL}/cancel`
  })
  res.json({url:session.url})
})

// ========================
// 🔥 STRIPE WEBHOOK (DEPOIS DA FUNÇÃO WHATSAPP)
// ========================
app.post('/webhook/stripe', express.raw({type:'application/json'}), async (req,res)=>{
  try{
    const event=stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    )

    if(event.type==='checkout.session.completed'){
      const session=event.data.object
      const id=session.metadata.atendimentoId

      await db.atualizarStatusPagamento(id,true,'FILA')
      const at=await db.buscarAtendimentoPorId(id)

      if(at?.elegivel) await memed.emitirReceita(at)
      if(at?.paciente_telefone) await enviarWhatsApp(decrypt(at.paciente_telefone),`✅ Pagamento confirmado! Atendimento ${id} em andamento.`)
    }
    res.json({ok:true})
  }catch(e){
    console.error(e)
    res.status(400).send('Erro webhook')
  }
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
app.post('/login',(req,res)=>{
  if(req.body.senha!==process.env.MEDICO_PASS)return res.status(401).json({error:'Senha inválida'})
  res.json({token:gerarToken()})
})

// ========================
// 📋 ROTAS PROTEGIDAS
// ========================
app.get('/api/atendimentos',auth,async(req,res)=>{
  const list=await db.getAtendimentos()
  res.json(list.map(a=>({...a,paciente_nome:decrypt(a.paciente_nome)})))
})

app.get('/api/fila',auth,async(req,res)=>{
  const atendimentos=await db.getAtendimentos()
  const fila=atendimentos.filter(a=>a.pagamento&&a.status==='FILA')
  res.json({total:fila.length,atendimentos:fila.map(a=>({...a,paciente_nome:decrypt(a.paciente_nome)}))})
})

app.get('/api/estatisticas',auth,async(req,res)=>{
  const a=await db.getAtendimentos()
  res.json({total:a.length,pagos:a.filter(x=>x.pagamento).length})
})

app.post('/api/decisao/:id',auth,async(req,res)=>{
  const novoStatus=req.body.decisao==='APROVAR'?'APROVADO':'RECUSADO'
  await db.atualizarStatus(req.params.id,novoStatus)
  res.json({ok:true})
})

app.get('/api/atendimento/:id',auth,async(req,res)=>{
  const at=await db.buscarAtendimentoPorId(req.params.id)
  if(!at) return res.status(404).json({error:'Atendimento não encontrado'})
  res.json({...at,paciente_nome:decrypt(at.paciente_nome),paciente_telefone:decrypt(at.paciente_telefone)})
})

// ========================
// 🏥 PAINEL MÉDICO (COMPLETO)
// ========================
app.get('/painel-medico',(req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Painel Médico</title>
    <meta charset="UTF-8">
    <style>
        body{font-family:Arial;margin:20px;background:#f0f2f5}
        .container{max-width:1200px;margin:0 auto}
        .card{background:white;border-radius:8px;padding:20px;margin-bottom:20px}
        h1{color:#1a6b8a}
        table{width:100%;border-collapse:collapse}
        th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}
        th{background:#1a6b8a;color:white}
        button{background:#28a745;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;margin:2px}
        .recusar{background:#dc3545}
        .stats{display:flex;gap:20px;margin-bottom:20px}
        .stat-card{background:white;padding:20px;text-align:center;flex:1;border-radius:8px}
        .stat-number{font-size:32px;font-weight:bold;color:#1a6b8a}
        input{padding:10px;margin:10px;width:200px}
    </style>
</head>
<body>
    <div class="login" style="text-align:center;margin-top:100px">
        <div class="card" style="max-width:400px;margin:0 auto">
            <h2>🔐 Painel Médico</h2>
            <input type="password" id="senha" placeholder="Senha">
            <button onclick="login()">Entrar</button>
            <p id="erro" style="color:red;display:none">Senha incorreta!</p>
        </div>
    </div>
    <div id="painel" class="container" style="display:none">
        <div class="card">
            <h1>📊 Painel Médico</h1>
            <div class="stats" id="stats"></div>
        </div>
        <div class="card">
            <div id="fila"></div>
        </div>
    </div>
    <script>
        const API_URL=window.location.origin
        let token=''
        async function login(){
            const senha=document.getElementById('senha').value
            try{
                const res=await fetch(API_URL+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({senha})})
                const data=await res.json()
                if(data.token){
                    token=data.token
                    document.querySelector('.login').style.display='none'
                    document.getElementById('painel').style.display='block'
                    carregarDados()
                }else document.getElementById('erro').style.display='block'
            }catch(e){alert('Erro: '+e.message)}
        }
        async function carregarDados(){
            try{
                const res=await fetch(API_URL+'/api/estatisticas',{headers:{'Authorization':'Bearer '+token}})
                const stats=await res.json()
                document.getElementById('stats').innerHTML='<div class="stat-card"><div class="stat-number">'+stats.total+'</div><div>Total</div></div><div class="stat-card"><div class="stat-number">'+stats.pagos+'</div><div>Pagos</div></div>'
                const filaRes=await fetch(API_URL+'/api/fila',{headers:{'Authorization':'Bearer '+token}})
                const fila=await filaRes.json()
                let html='<h3>📋 Fila de Atendimentos</h3><table><thead><tr><th>ID</th><th>Paciente</th><th>Data</th><th>Ações</th></tr></thead><tbody>'
                if(fila.atendimentos&&fila.atendimentos.length){
                    for(const a of fila.atendimentos){
                        html+='<tr><td>'+a.id.substring(0,8)+'</td><td>'+a.paciente_nome+'</td><td>'+new Date(a.criado_em).toLocaleString()+'</td><td><button onclick="aprovar(\''+a.id+'\')">Aprovar</button><button class="recusar" onclick="recusar(\''+a.id+'\')">Recusar</button></td></tr>'
                    }
                }else html+='<tr><td colspan="4">Nenhum paciente na fila</td></tr>'
                html+='</tbody></table>'
                document.getElementById('fila').innerHTML=html
            }catch(e){document.getElementById('fila').innerHTML='<p>Erro: '+e.message+'</p>'}
        }
        async function aprovar(id){await fetch(API_URL+'/api/decisao/'+id,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({decisao:'APROVAR'})});carregarDados()}
        async function recusar(id){await fetch(API_URL+'/api/decisao/'+id,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({decisao:'RECUSAR'})});carregarDados()}
    </script>
</body>
</html>
  `)
})

// ========================
// 🩺 HEALTH
// ========================
app.get('/healthz',(req,res)=>res.json({ok:true}))
app.get('/success',(req,res)=>res.send('<h1>✅ Pagamento confirmado</h1>'))
app.get('/cancel',(req,res)=>res.send('<h1>❌ Pagamento cancelado</h1>'))
app.get('/',(req,res)=>res.json({status:'online',versao:'4.0'}))

app.listen(PORT,'0.0.0.0',()=>console.log(`🚀 Servidor rodando na porta ${PORT}`))
