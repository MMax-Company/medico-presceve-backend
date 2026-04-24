const express = require('express')
const cors = require('cors')
const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const db = require('./db')
const memed = require('./memed')

// ========================
// 🚀 CONFIGURAÇÕES INICIAIS
// ========================

// Inicializar banco de dados
db.initDB();

// Stripe - Pagamentos
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

// URL base (Railway fornece automaticamente)
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.BASE_URL || 'http://localhost:3002'

const PORT = process.env.PORT || 3002

// UltraMsg - WhatsApp
const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN

// Chave de criptografia (LGPD)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'minha-chave-secreta-de-32-caracteres!!'

const app = express()

// ========================
// 🔐 FUNÇÕES DE CRIPTOGRAFIA
// ========================
function encrypt(text) {
  if (!text) return null
  try {
    const cipher = crypto.createCipher('aes-256-cbc', ENCRYPTION_KEY)
    let encrypted = cipher.update(text.toString(), 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return encrypted
  } catch (error) {
    console.error('Erro ao criptografar:', error)
    return text
  }
}

function decrypt(encryptedText) {
  if (!encryptedText) return null
  try {
    const decipher = crypto.createDecipher('aes-256-cbc', ENCRYPTION_KEY)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (error) {
    console.error('Erro ao descriptografar:', error)
    return encryptedText
  }
}

// ========================
// 📱 VALIDAÇÃO DE TELEFONE
// ========================
function validarTelefone(telefone) {
  if (!telefone) return false
  const numeros = telefone.toString().replace(/\D/g, '')
  if (numeros.length === 11 || numeros.length === 13) return true
  return false
}

function formatarTelefone(telefone) {
  const numeros = telefone.toString().replace(/\D/g, '')
  if (numeros.length === 11) return `+55${numeros}`
  if (numeros.length === 13 && numeros.startsWith('55')) return `+${numeros}`
  return null
}

// ========================
// 📱 WHATSAPP - ULTRAMSG
// ========================
async function enviarWhatsApp(numero, mensagem, tipo = 'geral') {
  if (!validarTelefone(numero)) {
    console.log(`⚠️ Telefone inválido: ${numero}`)
    return false
  }

  const telefoneFormatado = formatarTelefone(numero)
  if (!telefoneFormatado) {
    console.log(`⚠️ Não foi possível formatar o telefone: ${numero}`)
    return false
  }

  if (!ULTRAMSG_INSTANCE || !ULTRAMSG_TOKEN) {
    console.log('⚠️ UltraMsg não configurada')
    return false
  }

  try {
    const params = new URLSearchParams()
    params.append('token', ULTRAMSG_TOKEN)
    params.append('to', telefoneFormatado)
    params.append('body', mensagem)
    params.append('priority', process.env.WHATSAPP_PRIORITY || '10')

    await axios.post(
      `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      }
    )

    console.log(`✅ WhatsApp enviado (${tipo}): ${telefoneFormatado}`)
    return true
  } catch (error) {
    console.error('❌ WhatsApp erro:', error.response?.data || error.message)
    return false
  }
}

// ========================
// 🔥 MIDDLEWARES
// ========================
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Middleware de log para debug
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`)
  next()
})

// ========================
// 🏠 HOME
// ========================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    mensagem: 'Doctor Prescreve API está funcionando!',
    versao: '2.0.0',
    endpoints: [
      '/estatisticas',
      '/dashboard', 
      '/fila',
      '/api/webhook/triagem',
      '/atendimentos',
      '/memed-token'
    ]
  })
})

// ========================
// 📊 DASHBOARD
// ========================
app.get('/dashboard', async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    
    const stats = {
      total: atendimentos.length,
      elegiveis: atendimentos.filter(a => a.elegivel).length,
      pagos: atendimentos.filter(a => a.pagamento).length,
      fila: atendimentos.filter(a => a.pagamento && a.status === 'FILA').length,
      inelegiveis: atendimentos.filter(a => !a.elegivel).length,
      ultimosAtendimentos: atendimentos.slice(0, 10).map(a => ({
        id: a.id,
        status: a.status,
        elegivel: a.elegivel,
        pagamento: a.pagamento,
        criadoEm: a.criado_em
      }))
    }
    
    res.json(stats)
  } catch (error) {
    console.error('Erro no dashboard:', error)
    res.status(500).json({ error: 'Erro interno no servidor' })
  }
})

// ========================
// 🔐 MEMED TOKEN
// ========================
app.get('/memed-token', async (req, res) => {
  try {
    const token = await memed.gerarTokenPrescritor()
    if (token) {
      res.json({ success: true, token })
    } else {
      res.status(500).json({ success: false, error: 'Não foi possível obter token Memed' })
    }
  } catch (error) {
    console.error('Erro Memed:', error)
    res.status(500).json({ success: false, error: 'Erro ao conectar com Memed' })
  }
})

// ========================
// 💳 PAGAMENTO
// ========================
app.get('/api/create-payment/:id', async (req, res) => {
  try {
    // Verificar se atendimento existe
    const atendimento = await db.buscarAtendimentoPorId(req.params.id)
    if (!atendimento) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      metadata: { atendimentoId: req.params.id },
      line_items: [{
        price_data: {
          currency: process.env.CURRENCY || 'brl',
          product_data: { 
            name: process.env.PRODUCT_NAME || 'Consulta Assíncrona',
            description: 'Consulta médica online com prescrição digital'
          },
          unit_amount: parseInt(process.env.PRODUCT_PRICE) || 6990
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      customer_email: atendimento.paciente_email || undefined
    })
    
    res.json({ url: session.url })
  } catch (err) {
    console.error('Erro ao criar pagamento:', err)
    res.status(500).json({ error: err.message })
  }
})

// ========================
// 🧠 TRIAGEM (CORE DO SISTEMA)
// ========================
app.post('/api/webhook/triagem', async (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Body vazio' })
  }

  const { paciente = {}, triagem = {} } = req.body

  if (!paciente.nome || !triagem.doencas) {
    return res.status(400).json({ error: 'Dados incompletos: paciente.nome e triagem.doencas são obrigatórios' })
  }

  const id = req.body?.id || uuidv4()

  // Processamento da elegibilidade
  let doencaTexto = ''
  if (Array.isArray(triagem?.doencas)) {
    doencaTexto = triagem.doencas.join(' ').toLowerCase()
  } else {
    doencaTexto = triagem?.doencas?.toString().toLowerCase() || ''
  }

  const doencasValidas = ['has', 'hipertensao', 'dm', 'diabetes', 'dlp', 'dislipidemia', 'hipotireoidismo']
  const doencaValida = doencasValidas.some(doenca => doencaTexto.includes(doenca))
  
  const receitaValida = triagem?.receitaValida !== false
  const sinaisAlerta = triagem?.sinaisAlerta === true || triagem?.sinaisAlerta === 'true' || triagem?.sinaisAlerta === 'SIM'

  const elegivel = doencaValida && receitaValida && !sinaisAlerta
  
  let motivo = null
  if (!elegivel) {
    if (!doencaValida) motivo = 'Doença não atendida no momento'
    else if (!receitaValida) motivo = 'Receita médica vencida ou inválida'
    else if (sinaisAlerta) motivo = 'Sinais de alerta identificados - Procure atendimento presencial'
  }

  const atendimento = {
    id,
    paciente: {
      nome: encrypt(paciente.nome || ''),
      cpf: encrypt(paciente.cpf || ''),
      telefone: encrypt(paciente.telefone || ''),
      email: encrypt(paciente.email || ''),
      data_nascimento: paciente.data_nascimento || null
    },
    triagem: {
      ...triagem,
      doencas: doencaTexto,
      processadoEm: new Date().toISOString()
    },
    elegivel,
    motivo,
    status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
    pagamento: false,
    criadoEm: new Date().toISOString()
  }

  await db.salvarAtendimento(atendimento)

  console.log(`📋 Novo atendimento: ${id} - Elegível: ${elegivel}`)

  // Enviar WhatsApp se elegível
  if (elegivel && paciente.telefone && validarTelefone(paciente.telefone)) {
    const mensagemWhats = `🏥 *Doctor Prescreve*\n\nOlá ${paciente.nome}! ✅ Seu atendimento foi pré-aprovado.\n\n🔗 *Link para pagamento:*\n${BASE_URL}/api/create-payment/${id}\n\n💰 Valor: R$ 69,90\n\nApós o pagamento, sua receita será emitida em até 24h.`
    await enviarWhatsApp(paciente.telefone, mensagemWhats, 'triagem')
  }

  if (elegivel) {
    return res.json({
      success: true,
      elegivel: true,
      atendimentoId: id,
      pagamentoUrl: `${BASE_URL}/api/create-payment/${id}`,
      mensagem: 'Atendimento elegível. Realize o pagamento para continuar.'
    })
  }

  return res.json({
    success: false,
    elegivel: false,
    motivo,
    mensagem: `Infelizmente não podemos prosseguir. Motivo: ${motivo}`
  })
})

// ========================
// 💰 SUCCESS (Pós-pagamento)
// ========================
app.get('/success', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id)
    const id = session.metadata.atendimentoId

    const at = await db.buscarAtendimentoPorId(id)

    if (at) {
      await db.atualizarStatusPagamento(id, true, at.elegivel ? 'FILA' : 'INELEGIVEL')
      
      // Emitir receita via Memed
      if (at.elegivel) {
        try {
          const receita = await memed.emitirReceita(at)
          console.log(`📄 Receita emitida: ${receita.link}`)
        } catch (error) {
          console.error('Erro ao emitir receita:', error)
        }
      }
      
      // Enviar WhatsApp de confirmação
      if (at.paciente_telefone) {
        const telefone = decrypt(at.paciente_telefone)
        if (validarTelefone(telefone)) {
          const mensagemWhats = `✅ *Pagamento Confirmado!*\n\nSeu atendimento ID: ${id} entrou na fila.\nSua receita será emitida em breve e enviada por WhatsApp.`
          await enviarWhatsApp(telefone, mensagemWhats, 'pagamento')
        }
      }
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Pagamento Confirmado - Doctor Prescreve</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { background: white; border-radius: 10px; padding: 40px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #28a745; }
            button { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 20px; }
            button:hover { background: #0056b3; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Pagamento Confirmado!</h1>
            <p>Seu pagamento foi processado com sucesso.</p>
            <p>Sua receita será emitida em breve.</p>
            <button onclick="window.location.href='/dashboard'">Ver Dashboard</button>
          </div>
        </body>
      </html>
    `)
  } catch (error) {
    console.error('Erro no success:', error)
    res.send('<h1>❌ Erro no Pagamento</h1><p>Ocorreu um erro ao processar seu pagamento. Entre em contato com o suporte.</p>')
  }
})

// ========================
// 📋 FILA
// ========================
app.get('/fila', async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    const fila = atendimentos.filter(a => a.pagamento && a.status === 'FILA')
    res.json({
      total: fila.length,
      atendimentos: fila.map(a => ({
        id: a.id,
        criadoEm: a.criado_em,
        paciente_nome: decrypt(a.paciente_nome)
      }))
    })
  } catch (error) {
    console.error('Erro na fila:', error)
    res.status(500).json({ error: 'Erro ao buscar fila' })
  }
})

// ========================
// 📋 TODOS ATENDIMENTOS
// ========================
app.get('/atendimentos', async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    res.json(atendimentos.map(a => ({
      id: a.id,
      elegivel: a.elegivel,
      status: a.status,
      pagamento: a.pagamento,
      criadoEm: a.criado_em,
      motivo: a.motivo
    })))
  } catch (error) {
    console.error('Erro ao buscar atendimentos:', error)
    res.status(500).json({ error: 'Erro ao buscar atendimentos' })
  }
})

// ========================
// 👨‍⚕️ BUSCAR ATENDIMENTO POR ID
// ========================
app.get('/atendimento/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    const atendimentoDecrypt = {
      ...at,
      paciente: {
        nome: decrypt(at.paciente_nome),
        cpf: decrypt(at.paciente_cpf),
        telefone: decrypt(at.paciente_telefone),
        email: decrypt(at.paciente_email)
      }
    }
    
    res.json(atendimentoDecrypt)
  } catch (error) {
    console.error('Erro ao buscar atendimento:', error)
    res.status(500).json({ error: 'Erro ao buscar atendimento' })
  }
})

// ========================
// 📊 ESTATÍSTICAS
// ========================
app.get('/estatisticas', async (req, res) => {
  try {
    const stats = await db.getEstatisticas()
    res.json(stats)
  } catch (error) {
    console.error('Erro nas estatísticas:', error)
    res.status(500).json({ error: 'Erro ao buscar estatísticas' })
  }
})

// ========================
// ❌ CANCEL
// ========================
app.get('/cancel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pagamento Cancelado - Doctor Prescreve</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { background: white; border-radius: 10px; padding: 40px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #dc3545; }
          button { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 20px; }
          button:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ Pagamento Cancelado</h1>
          <p>Você cancelou o pagamento. Nenhum valor foi cobrado.</p>
          <p>Você pode tentar novamente quando quiser.</p>
          <button onclick="window.history.back()">Voltar</button>
        </div>
      </body>
    </html>
  `)
})

// ========================
// 🏥 HEALTH CHECK (Para Railway)
// ========================
app.get('/healthz', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// ========================
// 🔄 ROTA 404
// ========================
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' })
})

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50))
  console.log(`🚀 Doctor Prescreve API - Rodando na porta ${PORT}`)
  console.log(`🌍 URL Pública: ${BASE_URL}`)
  console.log(`🔐 Criptografia: ATIVA (LGPD)`)
  console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE ? 'CONFIGURADO ✅' : 'NÃO CONFIGURADO ⚠️'}`)
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'CONFIGURADO ✅' : 'NÃO CONFIGURADO ⚠️'}`)
  console.log(`🗄️ Banco: PostgreSQL (Railway)`)
  console.log(`📋 Health Check: ${BASE_URL}/healthz`)
  console.log('='.repeat(50))
})

module.exports = app