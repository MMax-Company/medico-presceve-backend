require('dotenv').config()

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')
const PDFDocument = require('pdfkit')
const {
  adicionarFilaSuporte,
  getFilaSuporte,
  responderFilaSuporte
} = require('./db')

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
const WEBHOOK_EVENTS_DIR = 'webhook_events'

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
if (!fs.existsSync(WEBHOOK_EVENTS_DIR)) fs.mkdirSync(WEBHOOK_EVENTS_DIR, { recursive: true })

// Webhook events DB (para evitar duplicação)
const webhookDb = {
  async salvarEvento(eventId, eventType, atendimentoId) {
    const file = path.join(WEBHOOK_EVENTS_DIR, `${eventId}.json`)
    const evento = {
      id: eventId,
      type: eventType,
      atendimentoId,
      processado_em: new Date().toISOString()
    }
    fs.writeFileSync(file, JSON.stringify(evento, null, 2))
    console.log(`✅ Evento Stripe registrado: ${eventId}`)
  },

  async eventoJaProcessado(eventId) {
    const file = path.join(WEBHOOK_EVENTS_DIR, `${eventId}.json`)
    return fs.existsSync(file)
  }
}

// Função para calcular tempo médio de espera
function calcularTempoMedioEspera(atendimentos) {
  const aprovados = atendimentos.filter(a => a.status === 'APROVADO' && a.pago_em && a.finalizado_em)
  if (aprovados.length === 0) return 0
  
  const totalMinutos = aprovados.reduce((sum, a) => {
    const pagamento = new Date(a.pago_em)
    const finalizado = new Date(a.finalizado_em)
    return sum + ((finalizado - pagamento) / 60000)
  }, 0)
  
  return Math.floor(totalMinutos / aprovados.length)
}

// Main DB
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
  },

  async salvarProntuario(id, prontuario) {
    const at = await this.buscarAtendimentoPorId(id)
    if (at) {
      at.prontuario = prontuario
      at.status = 'PRONTO_PARA_DECISAO'
      at.prontuario_atualizado_em = new Date().toISOString()
      await this.salvarAtendimento(at)
    }
  },

  async tentarPegarAtendimento(atendimentoId, medicoId, lockTimeMinutes = 30) {
    const at = await this.buscarAtendimentoPorId(atendimentoId)
    
    if (!at) return { sucesso: false, motivo: 'Atendimento não encontrado' }
    
    if (at.status === 'EM_ATENDIMENTO') {
      const lockExpirado = at.locked_until && new Date(at.locked_until) < new Date()
      if (!lockExpirado) {
        return { 
          sucesso: false, 
          motivo: 'Já em atendimento por outro médico',
          medico: at.em_atendimento_por,
          desde: at.em_atendimento_desde
        }
      }
    }
    
    at.status = 'EM_ATENDIMENTO'
    at.em_atendimento_por = medicoId
    at.em_atendimento_desde = new Date().toISOString()
    at.locked_until = new Date(Date.now() + lockTimeMinutes * 60000).toISOString()
    at.tentativas_lock = (at.tentativas_lock || 0) + 1
    
    await this.salvarAtendimento(at)
    
    return { 
      sucesso: true, 
      atendimento: at,
      lock_expira: at.locked_until
    }
  },

  async liberarAtendimento(atendimentoId, manterLock = false) {
    const at = await this.buscarAtendimentoPorId(atendimentoId)
    if (!at) return false
    
    if (!manterLock) {
      at.status = 'FILA'
      at.em_atendimento_por = null
      at.em_atendimento_desde = null
      at.locked_until = null
    }
    
    await this.salvarAtendimento(at)
    return true
  },

  async getFilaOrdenada() {
    const atendimentos = await this.getAtendimentos()
    
    const fila = atendimentos.filter(a => {
      if (!a.pagamento) return false
      if (a.status === 'APROVADO' || a.status === 'RECUSADO') return false
      if (a.status === 'EM_ATENDIMENTO') {
        if (a.locked_until && new Date(a.locked_until) < new Date()) {
          return true
        }
        return false
      }
      return a.status === 'FILA'
    })
    
    fila.sort((a, b) => {
      if (a.prioridade !== b.prioridade) return (b.prioridade || 0) - (a.prioridade || 0)
      return new Date(a.pago_em || a.criado_em) - new Date(b.pago_em || b.criado_em)
    })
    
    return fila
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
// 📄 GERADOR DE PDF
// ========================
async function gerarReceitaPDF(atendimento, prontuario, orientacoes) {
  return new Promise(async (resolve, reject) => {
    try {
      const pacienteNome = decrypt(atendimento.paciente_nome)
      const pacienteCpf = decrypt(atendimento.paciente_cpf)
      const pacienteTelefone = decrypt(atendimento.paciente_telefone)
      const doencas = decrypt(atendimento.doencas)
      
      const filename = `receita_${atendimento.id}.pdf`
      const filepath = path.join(DB_DIR, filename)
      
      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const stream = fs.createWriteStream(filepath)
      doc.pipe(stream)
      
      doc.fontSize(20).font('Helvetica-Bold').text('RECEITA MÉDICA', { align: 'center' })
      doc.moveDown()
      doc.fontSize(12).font('Helvetica').text('Doctor Prescreve - Telemedicina', { align: 'center' })
      doc.moveDown()
      doc.text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, { align: 'right' })
      doc.moveDown()
      
      doc.fontSize(14).font('Helvetica-Bold').text('DADOS DO PACIENTE')
      doc.moveDown(0.5)
      doc.fontSize(11).font('Helvetica')
      doc.text(`Nome: ${pacienteNome}`)
      doc.text(`CPF: ${pacienteCpf}`)
      doc.text(`Telefone: ${pacienteTelefone}`)
      doc.text(`Diagnóstico: ${doencas}`)
      doc.moveDown()
      
      doc.fontSize(14).font('Helvetica-Bold').text('PRESCRIÇÃO')
      doc.moveDown(0.5)
      doc.fontSize(11).font('Helvetica')
      
      const medicamentos = prontuario?.medicamentos || []
      if (medicamentos.length > 0) {
        medicamentos.forEach((med, index) => {
          doc.text(`${index + 1}. ${med.nome} - ${med.dosagem}`)
          doc.text(`   Duração: ${med.duracao} - Quantidade: ${med.quantidade} unidades`)
          if (med.instrucoes) doc.text(`   Instruções: ${med.instrucoes}`)
          doc.moveDown(0.5)
        })
      } else if (prontuario?.medicacao) {
        doc.text(prontuario.medicacao)
        doc.moveDown()
      }
      
      const textoOrientacoes = orientacoes || prontuario?.orientacoes
      if (textoOrientacoes) {
        doc.moveDown()
        doc.fontSize(12).font('Helvetica-Bold').text('ORIENTAÇÕES MÉDICAS')
        doc.moveDown(0.5)
        doc.fontSize(11).font('Helvetica').text(textoOrientacoes)
      }
      
      doc.moveDown()
      doc.text('_________________________________')
      doc.text(`${process.env.MEDICO_NOME || 'Dr.'} ${process.env.MEDICO_SOBRENOME || 'Medico'}`)
      doc.text(`${process.env.MEDICO_CONSELHO || 'CRM'}/${process.env.MEDICO_UF || 'SP'} ${process.env.MEDICO_NUMERO || '123456'}`)
      doc.text('Assinatura Digital')
      
      doc.moveDown()
      doc.fontSize(9).text('Receita válida por 30 dias. Venda sob prescrição médica.', { align: 'center' })
      doc.text('Este documento foi gerado eletronicamente e tem validade legal conforme Lei 13.989/2020.', { align: 'center' })
      
      doc.end()
      
      stream.on('finish', () => {
        console.log(`✅ PDF gerado: ${filename}`)
        resolve({ sucesso: true, arquivo: filepath, url: `/receita-pdf/${atendimento.id}` })
      })
      
      stream.on('error', reject)
    } catch (e) {
      reject(e)
    }
  })
}

// ========================
// 🧠 FUNÇÃO PRINCIPAL DE ENVIO DE RECEITA
// ========================
async function enviarReceitaComFallback(atendimentoId, prontuario, orientacoes) {
  const at = await db.buscarAtendimentoPorId(atendimentoId)
  if (!at) return { sucesso: false, motivo: 'Atendimento não encontrado' }
  
  let pdfSucesso = false
  let pdfUrl = null
  
  try {
    const pdfResult = await gerarReceitaPDF(at, prontuario, orientacoes)
    if (pdfResult.sucesso) {
      pdfSucesso = true
      pdfUrl = pdfResult.url
      console.log(`✅ PDF gerado: ${atendimentoId}`)
    }
  } catch (e) {
    console.error(`❌ PDF falhou: ${e.message}`)
  }
  
  at.receita_enviada_por = pdfSucesso ? 'pdf_fallback' : 'nenhum'
  if (pdfUrl) at.receita_pdf_url = pdfUrl
  at.receita_enviada_em = new Date().toISOString()
  await db.salvarAtendimento(at)
  
  return {
    sucesso: pdfSucesso,
    metodo: pdfSucesso ? 'pdf_fallback' : 'falhou',
    pdf_url: pdfUrl
  }
}

// ========================
// 🛡️ MIDDLEWARES
// ========================
app.set('trust proxy', 1)
app.use(cors())
app.use(express.json())
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))

// Rota para servir PDF
app.get('/receita-pdf/:id', async (req, res) => {
  const filepath = path.join(DB_DIR, `receita_${req.params.id}.pdf`)
  if (fs.existsSync(filepath)) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename=receita_${req.params.id}.pdf`)
    fs.createReadStream(filepath).pipe(res)
  } else {
    res.status(404).send('Receita não encontrada')
  }
})

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

    let texto = ''
    if (Array.isArray(triagem.doencas)) {
      texto = triagem.doencas.join(' ').toLowerCase()
    } else {
      texto = (triagem.doencas || '').toLowerCase()
    }

    const doencasElegiveis = [
      'has', 'hipertensao', 'hipertensão', 'pressao alta',
      'diabetes', 'diabete', 'dm', 'diabetes mellitus',
      'dlp', 'dislipidemia', 'colesterol alto', 'triglicerides',
      'hipotireoidismo', 'hipotireoide'
    ]

    const textoNormalizado = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const elegivel = doencasElegiveis.some(d => textoNormalizado.includes(d))

    const atendimento = {
      id,
      paciente_nome: encrypt(paciente.nome),
      paciente_telefone: encrypt(paciente.telefone || ''),
      paciente_cpf: encrypt(paciente.cpf || ''),
      paciente_email: encrypt(paciente.email || ''),
      paciente_nascimento: encrypt(paciente.data_nascimento || ''),
      doencas: encrypt(texto),
      medicamento: encrypt(triagem.medicamento || ''),
      medicamento2: encrypt(triagem.medicamento2 || ''),
      tempo_uso: encrypt(triagem.tempoUso || ''),
      sinais_alerta: encrypt(String(triagem.sinaisAlerta || '')),
      elegivel,
      status: elegivel ? 'AGUARDANDO_PAGAMENTO' : 'INELEGIVEL',
      pagamento: false,
      criado_em: new Date().toISOString(),
      pago_em: null,
      em_atendimento_por: null,
      em_atendimento_desde: null,
      prioridade: 0,
      tentativas_lock: 0,
      locked_until: null
    }

    await db.salvarAtendimento(atendimento)

    if (elegivel) {
      const url = `${BASE_URL}/api/payment/${id}`
      await enviarWhatsApp(paciente.telefone, `✅ Olá ${paciente.nome}! Sua triagem foi aprovada! Link: ${url}`)
    } else {
      await enviarWhatsApp(paciente.telefone, '❌ Não elegível para teleconsulta.')
    }

    res.json({ success: true, id, elegivel, payment_url: elegivel ? `${BASE_URL}/api/payment/${id}` : null })
  } catch(e) {
    console.error('❌ Erro na triagem:', e)
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
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado')
    return res.status(400).send('Webhook secret não configurado')
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error(`❌ Webhook signature error: ${err.message}`)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  const eventId = event.id
  const eventType = event.type

  const jaProcessado = await webhookDb.eventoJaProcessado(eventId)
  if (jaProcessado) {
    console.log(`⚠️ Evento ${eventId} já processado. Ignorando.`)
    return res.json({ received: true, alreadyProcessed: true })
  }

  if (eventType === 'checkout.session.completed') {
    const session = event.data.object
    const atendimentoId = session.metadata?.atendimentoId

    if (atendimentoId) {
      const at = await db.buscarAtendimentoPorId(atendimentoId)
      
      if (!at) {
        console.error(`❌ Atendimento não encontrado: ${atendimentoId}`)
        return res.status(404).json({ error: 'Atendimento não encontrado' })
      }

      if (at.pagamento) {
        console.log(`⚠️ Atendimento ${atendimentoId} já está com pagamento confirmado.`)
        await webhookDb.salvarEvento(eventId, eventType, atendimentoId)
        return res.json({ received: true, alreadyPaid: true })
      }

      await db.atualizarStatusPagamento(atendimentoId, true, 'FILA')
      await webhookDb.salvarEvento(eventId, eventType, atendimentoId)

      const telefone = decrypt(at.paciente_telefone)
      await enviarWhatsApp(telefone, '✅ Pagamento confirmado! Você está na fila.')

      console.log(`💰 Pagamento confirmado: ${atendimentoId}`)
    }
  }

  res.json({ received: true })
})

// ========================
// 👨‍⚕️ LOGIN
// ========================
function gerarToken() {
  return jwt.sign({ role: 'medico' }, process.env.JWT_SECRET, { expiresIn: '12h' })
}

app.post('/login', (req, res) => {
  if (req.body.senha !== process.env.MEDICO_PASS) {
    return res.status(401).json({ error: 'Senha inválida' })
  }
  res.json({ token: gerarToken() })
})

// ========================
// 📋 ROTAS DA FILA
// ========================
app.post('/api/fila/pegar-proximo', async (req, res) => {
  try {
    const medicoId = req.body.medicoId || 'medico_principal'
    const fila = await db.getFilaOrdenada()
    
    if (fila.length === 0) {
      return res.json({ sucesso: false, motivo: 'Fila vazia' })
    }
    
    const proximo = fila[0]
    const resultado = await db.tentarPegarAtendimento(proximo.id, medicoId)
    
    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        atendimento: {
          ...resultado.atendimento,
          paciente_nome: decrypt(resultado.atendimento.paciente_nome),
          paciente_telefone: decrypt(resultado.atendimento.paciente_telefone),
          paciente_cpf: decrypt(resultado.atendimento.paciente_cpf),
          doencas: decrypt(resultado.atendimento.doencas)
        },
        lock_expira: resultado.lock_expira
      })
    } else {
      res.json(resultado)
    }
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/fila/liberar/:id', async (req, res) => {
  try {
    await db.liberarAtendimento(req.params.id)
    res.json({ sucesso: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/fila/finalizar/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (at) {
      at.status = req.body.status
      at.finalizado_em = new Date().toISOString()
      await db.salvarAtendimento(at)
    }
    res.json({ sucesso: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/fila/estatisticas', async (req, res) => {
  try {
    const todos = await db.getAtendimentos()
    const fila = await db.getFilaOrdenada()
    
    const emAtendimento = todos.filter(a => a.status === 'EM_ATENDIMENTO' && a.locked_until && new Date(a.locked_until) > new Date())
    const locksExpirados = todos.filter(a => a.status === 'EM_ATENDIMENTO' && a.locked_until && new Date(a.locked_until) < new Date())
    
    res.json({
      total_fila: fila.length,
      em_atendimento: emAtendimento.length,
      locks_expirados: locksExpirados.length,
      tempo_medio_espera: calcularTempoMedioEspera(todos),
      proximos: fila.slice(0, 5).map(a => ({
        id: a.id.substring(0,8),
        espera_minutos: Math.floor((Date.now() - new Date(a.pago_em || a.criado_em)) / 60000)
      }))
    })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📋 ROTAS PÚBLICAS
// ========================
app.get('/api/pacientes', async (req, res) => {
  try {
    const atendimentos = await db.getAtendimentos()
    res.json(atendimentos.map(a => ({
      id: a.id,
      paciente_nome: decrypt(a.paciente_nome),
      paciente_telefone: decrypt(a.paciente_telefone),
      paciente_email: decrypt(a.paciente_email),
      paciente_nascimento: decrypt(a.paciente_nascimento),
      doencas: decrypt(a.doencas),
      medicamento: decrypt(a.medicamento),
      medicamento2: decrypt(a.medicamento2),
      tempo_uso: decrypt(a.tempo_uso),
      status: a.status,
      pagamento: a.pagamento,
      criado_em: a.criado_em
    })))
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/estatisticas', async (req, res) => {
  const a = await db.getAtendimentos()
  res.json({
    total: a.length,
    naFila: a.filter(x => x.pagamento && x.status === 'FILA').length,
    aprovados: a.filter(x => x.status === 'APROVADO').length,
    recusados: a.filter(x => x.status === 'RECUSADO').length
  })
})

app.get('/api/atendimentos', async (req, res) => {
  const list = await db.getAtendimentos()
  res.json(list.map(a => ({ 
    ...a, 
    paciente_nome: decrypt(a.paciente_nome), 
    paciente_telefone: decrypt(a.paciente_telefone), 
    doencas: decrypt(a.doencas),
    medicamento: decrypt(a.medicamento),
    medicamento2: decrypt(a.medicamento2),
    tempo_uso: decrypt(a.tempo_uso)
  })))
})

// ========================
// 📞 ROTAS DE SUPORTE
// ========================
const suportesPendentes = {}

app.post('/api/suporte/solicitar', async (req, res) => {
  try {
    const { telefone, nome, mensagem } = req.body
    const id = Math.random().toString(36).substring(2, 10)
    
    suportesPendentes[id] = {
      id, telefone, nome: nome || 'Paciente',
      mensagem: mensagem || 'Aguardando atendimento',
      status: 'PENDENTE',
      criado_em: new Date().toISOString()
    }
    
    console.log(`📞 NOVO SUPORTE: ${nome} (${telefone})`)
    res.json({ success: true, id })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/suporte/pendentes', async (req, res) => {
  const pendentes = Object.values(suportesPendentes).filter(s => s.status === 'PENDENTE')
  res.json(pendentes)
})

app.post('/api/suporte/atender/:id', async (req, res) => {
  const { id } = req.params
  if (suportesPendentes[id]) {
    suportesPendentes[id].status = 'ATENDIDO'
    suportesPendentes[id].atendido_em = new Date().toISOString()
  }
  res.json({ success: true })
})

app.post('/api/enviar-whatsapp', async (req, res) => {
  try {
    const { telefone, mensagem } = req.body
    await enviarWhatsApp(telefone, mensagem)
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📞 FILA DE SUPORTE (persistente)
// ========================

// Validação de telefone: aceita 10 ou 11 dígitos (com ou sem DDD)
function validarTelefone(telefone) {
  const digits = String(telefone || '').replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 11
}

// POST /suporte/entrar — paciente entra na fila
app.post('/suporte/entrar', async (req, res) => {
  try {
    const { telefone, nome } = req.body

    if (!telefone || !nome) {
      return res.status(400).json({ error: 'Os campos "telefone" e "nome" são obrigatórios.' })
    }

    const nomeTrimmed = String(nome).trim()
    if (nomeTrimmed.length < 2 || nomeTrimmed.length > 255) {
      return res.status(400).json({ error: 'O nome deve ter entre 2 e 255 caracteres.' })
    }

    if (!validarTelefone(telefone)) {
      return res.status(400).json({ error: 'Número de telefone inválido. Informe DDD + número (10 ou 11 dígitos).' })
    }

    const telefoneLimpo = String(telefone).replace(/\D/g, '')

    const registro = await adicionarFilaSuporte(telefoneLimpo, nomeTrimmed)
    if (!registro) {
      return res.status(503).json({ error: 'Não foi possível entrar na fila. Tente novamente.' })
    }

    console.log(`📞 Paciente entrou na fila de suporte: ${nomeTrimmed} (${telefoneLimpo})`)
    res.status(201).json({
      success: true,
      id: registro.id,
      nome: registro.nome,
      status: registro.status,
      criado_em: registro.criado_em
    })
  } catch (e) {
    console.error('❌ Erro em POST /suporte/entrar:', e)
    res.status(500).json({ error: 'Erro interno ao entrar na fila.' })
  }
})

// GET /suporte/fila — médico visualiza a fila
app.get('/suporte/fila', async (req, res) => {
  try {
    const fila = await getFilaSuporte()
    res.json(fila)
  } catch (e) {
    console.error('❌ Erro em GET /suporte/fila:', e)
    res.status(500).json({ error: 'Erro interno ao buscar a fila.' })
  }
})

// POST /suporte/responder — médico responde e remove da fila
app.post('/suporte/responder', async (req, res) => {
  try {
    const { id, mensagem } = req.body

    if (!id) {
      return res.status(400).json({ error: 'O campo "id" é obrigatório.' })
    }

    const idNum = parseInt(id, 10)
    if (isNaN(idNum) || idNum <= 0) {
      return res.status(400).json({ error: 'O campo "id" deve ser um número inteiro positivo.' })
    }

    if (!mensagem || String(mensagem).trim().length === 0) {
      return res.status(400).json({ error: 'O campo "mensagem" é obrigatório e não pode estar vazio.' })
    }

    const mensagemTrimmed = String(mensagem).trim()
    if (mensagemTrimmed.length > 4096) {
      return res.status(400).json({ error: 'A mensagem não pode ultrapassar 4096 caracteres.' })
    }

    const registro = await responderFilaSuporte(idNum)
    if (!registro) {
      return res.status(404).json({ error: 'Paciente não encontrado na fila ou já foi respondido.' })
    }

    const instance = process.env.ULTRAMSG_INSTANCE
    const token = process.env.ULTRAMSG_TOKEN

    if (!instance || !token) {
      console.warn('⚠️ ULTRAMSG_INSTANCE ou ULTRAMSG_TOKEN não configurados — mensagem não enviada.')
      return res.json({
        success: true,
        aviso: 'Paciente removido da fila, mas WhatsApp não enviado (credenciais UltraMsg ausentes).',
        registro
      })
    }

    const telefoneLimpo = String(registro.telefone).replace(/\D/g, '')
    if (!validarTelefone(telefoneLimpo)) {
      console.warn(`⚠️ Telefone inválido para envio WhatsApp: ${registro.telefone}`)
      return res.json({
        success: true,
        aviso: 'Paciente removido da fila, mas o número de telefone é inválido para envio de WhatsApp.',
        registro
      })
    }

    try {
      await axios.post(
        `https://api.ultramsg.com/${instance}/messages/chat`,
        new URLSearchParams({
          token,
          to: `+55${telefoneLimpo}`,
          body: mensagemTrimmed
        }),
        { timeout: 10000 }
      )
      console.log(`✅ WhatsApp de suporte enviado para ${telefoneLimpo}`)
    } catch (waErr) {
      console.error(`❌ Falha ao enviar WhatsApp para ${telefoneLimpo}:`, waErr.message)
      return res.status(502).json({
        error: 'Paciente removido da fila, mas houve falha ao enviar a mensagem WhatsApp.',
        detalhe: waErr.message
      })
    }

    res.json({ success: true, registro })
  } catch (e) {
    console.error('❌ Erro em POST /suporte/responder:', e)
    res.status(500).json({ error: 'Erro interno ao responder paciente.' })
  }
})

// ========================
// 🔧 ROTA PARA SIMULAR PAGAMENTO
// ========================
app.post('/api/teste/simular-pagamento/:id', async (req, res) => {
  try {
    const { id } = req.params
    const at = await db.buscarAtendimentoPorId(id)
    
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    if (at.pagamento) {
      return res.json({ message: 'Pagamento já confirmado', status: at.status })
    }
    
    at.pagamento = true
    at.status = 'FILA'
    at.pago_em = new Date().toISOString()
    
    await db.salvarAtendimento(at)
    
    const telefone = decrypt(at.paciente_telefone)
    if (telefone) {
      await enviarWhatsApp(telefone, '✅ Pagamento confirmado! Você está na fila.')
    }
    
    res.json({ success: true, message: 'Pagamento simulado com sucesso', status: at.status })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 💾 SALVAR PRONTUÁRIO
// ========================
app.post('/api/salvar-prontuario/:id', async (req, res) => {
  try {
    const { id } = req.params
    const dadosProntuario = req.body
    
    const at = await db.buscarAtendimentoPorId(id)
    if (!at) {
      return res.status(404).json({ error: 'Atendimento não encontrado' })
    }
    
    await db.salvarProntuario(id, dadosProntuario)
    
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ========================
// ⚖️ DECISÃO MÉDICA
// ========================
app.post('/api/decisao/:id', async (req, res) => {
  try {
    const { decisao, orientacoes } = req.body
    const novoStatus = decisao === 'APROVAR' ? 'APROVADO' : 'RECUSADO'
    
    await db.atualizarStatus(req.params.id, novoStatus)

    const at = await db.buscarAtendimentoPorId(req.params.id)
    const telefone = decrypt(at.paciente_telefone)
    const nome = decrypt(at.paciente_nome)

    if (decisao === 'APROVAR') {
      const resultado = await enviarReceitaComFallback(req.params.id, at.prontuario, orientacoes)
      
      let msg = `✅ Ótimas notícias, ${nome}!\n\n🎉 Sua receita foi APROVADA!\n\n📋 Número: ${req.params.id.substring(0, 8)}\n`
      
      if (resultado.metodo === 'pdf_fallback' && resultado.pdf_url) {
        msg += `📄 Clique para baixar sua receita: ${BASE_URL}${resultado.pdf_url}\n`
      } else {
        msg += `⚠️ Aguarde, a receita será enviada em breve.\n`
      }
      
      if (orientacoes) msg += `\n📝 Orientações: ${orientacoes}`
      
      await enviarWhatsApp(telefone, msg)
      
      at.decisao_historico = {
        status: 'APROVADO',
        data: new Date().toISOString(),
        medico: 'sistema',
        orientacoes,
        receita_envio: resultado
      }
      await db.salvarAtendimento(at)
      
    } else {
      let msg = `❌ Infelizmente, sua receita foi RECUSADA.\n\n📋 Número: ${req.params.id.substring(0, 8)}\n`
      if (orientacoes) msg += `\n📝 Motivo: ${orientacoes}`
      msg += `\n\n🏥 Procure um atendimento presencial.`
      
      await enviarWhatsApp(telefone, msg)
    }

    res.json({ success: true, novoStatus })
  } catch(e) {
    console.error('❌ Erro na decisão:', e)
    res.status(500).json({ error: e.message })
  }
})

// ========================
// 📋 PRONTUÁRIO DO PACIENTE
// ========================
app.get('/prontuario/:id', async (req, res) => {
  try {
    const at = await db.buscarAtendimentoPorId(req.params.id)
    if (!at) {
      return res.status(404).send('Prontuário não encontrado')
    }

    const pacienteNome = decrypt(at.paciente_nome) || ''
    const pacienteTelefone = decrypt(at.paciente_telefone) || ''
    const pacienteCpf = decrypt(at.paciente_cpf) || ''
    const pacienteEmail = decrypt(at.paciente_email) || ''
    const pacienteNascimento = decrypt(at.paciente_nascimento) || ''
    const doencas = decrypt(at.doencas) || ''
    const medicamento = decrypt(at.medicamento) || ''
    const medicamento2 = decrypt(at.medicamento2) || ''
    const tempoUso = decrypt(at.tempo_uso) || ''
    
    let medicacaoCompleta = medicamento
    if (medicamento2) {
      medicacaoCompleta += medicacaoCompleta ? `, ${medicamento2}` : medicamento2
    }
    
    const prontuario = at.prontuario || {}
    
    if (at.status === 'FILA') {
      await db.atualizarStatus(req.params.id, 'EM_ATENDIMENTO')
    }

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prontuário Médico</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 40px 20px; }
        .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); overflow: hidden; }
        .header { background: linear-gradient(135deg, #1a6b8a 0%, #0d4f6b 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 28px; }
        .content { padding: 30px; }
        .section { margin-bottom: 30px; border: 1px solid #e9ecef; border-radius: 16px; padding: 20px; background: #fafbfc; }
        .section-title { font-size: 18px; font-weight: bold; color: #1a6b8a; margin-bottom: 20px; border-bottom: 2px solid #e9ecef; padding-bottom: 10px; }
        .form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
        .form-group { display: flex; flex-direction: column; }
        .form-group label { font-size: 12px; font-weight: bold; color: #6c757d; text-transform: uppercase; margin-bottom: 5px; }
        .form-group input, .form-group textarea, .form-group select { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; }
        .full-width { grid-column: span 2; }
        .badge-chatbot { font-size: 10px; background: #4caf50; color: white; padding: 2px 8px; border-radius: 12px; margin-left: 10px; }
        .orientacao-box { background: #fff8e1; border-left: 4px solid #ffc107; padding: 20px; border-radius: 12px; margin-top: 10px; }
        .btn-salvar { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 14px; border: none; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; }
        .btn-salvar:hover { transform: translateY(-2px); }
        .btn-voltar { background: #6c757d; color: white; padding: 10px; border: none; border-radius: 8px; cursor: pointer; width: 100%; margin-top: 10px; }
        .info-chatbot { background: #e3f2fd; border-radius: 8px; padding: 10px; margin-bottom: 15px; font-size: 13px; color: #1565c0; text-align: center; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📋 Prontuário Médico</h1>
        <p>Doctor Prescreve - Avaliação Assíncrona</p>
    </div>
    <div class="content">
        <div class="info-chatbot">🤖 Dados pré-preenchidos pelo chatbot - Verifique e complete</div>
        
        <form id="formProntuario">
            <div class="section">
                <div class="section-title">👤 Dados Pessoais</div>
                <div class="form-grid">
                    <div class="form-group"><label>NOME <span class="badge-chatbot">Chatbot</span></label><input type="text" id="nome" value="${prontuario.nome || pacienteNome.replace(/[<>]/g, '')}"></div>
                    <div class="form-group"><label>NASCIMENTO <span class="badge-chatbot">Chatbot</span></label><input type="date" id="nascimento" value="${prontuario.nascimento || pacienteNascimento}"></div>
                    <div class="form-group"><label>EMAIL <span class="badge-chatbot">Chatbot</span></label><input type="email" id="email" value="${prontuario.email || pacienteEmail}"></div>
                    <div class="form-group"><label>CPF <span class="badge-chatbot">Chatbot</span></label><input type="text" id="cpf" value="${prontuario.cpf || pacienteCpf}"></div>
                    <div class="form-group"><label>WHATSAPP <span class="badge-chatbot">Chatbot</span></label><input type="text" id="whatsapp" value="${prontuario.whatsapp || pacienteTelefone}"></div>
                </div>
            </div>

            <div class="section">
                <div class="section-title">🏥 Condição Clínica</div>
                <div class="form-grid">
                    <div class="form-group full-width"><label>DOENÇAS <span class="badge-chatbot">Chatbot</span></label><input type="text" id="doencas" value="${prontuario.doencas || doencas.replace(/[<>]/g, '')}"></div>
                    <div class="form-group full-width"><label>MEDICAÇÃO EM USO <span class="badge-chatbot">Chatbot</span></label><textarea id="medicacao" rows="2">${prontuario.medicacao || medicacaoCompleta}</textarea></div>
                    <div class="form-group"><label>TEMPO DE USO <span class="badge-chatbot">Chatbot</span></label><input type="text" id="tempoUso" value="${prontuario.tempoUso || tempoUso}"></div>
                    <div class="form-group"><label>VALIDADE DA RECEITA</label><input type="date" id="validadeReceita" value="${prontuario.validadeReceita || ''}"></div>
                </div>
            </div>

            <div class="section">
                <div class="section-title">🩺 Avaliação Clínica</div>
                <div class="form-grid">
                    <div class="form-group full-width"><label>QUEIXA PRINCIPAL</label><textarea id="queixa" rows="2">${prontuario.queixa || ''}</textarea></div>
                    <div class="form-group full-width"><label>HISTÓRIA CLÍNICA</label><textarea id="historia" rows="3">${prontuario.historia || ''}</textarea></div>
                    <div class="form-group full-width"><label>CONDUTA / PRESCRIÇÃO</label><textarea id="conduta" rows="3">${prontuario.conduta || ''}</textarea></div>
                    <div class="form-group full-width orientacao-box"><label>📝 ORIENTAÇÕES MÉDICAS (OPCIONAL)</label><textarea id="orientacoes" rows="4" placeholder="Recomendações, alertas ou observações adicionais">${prontuario.orientacoes || ''}</textarea></div>
                </div>
            </div>

            <button type="button" class="btn-salvar" onclick="salvarProntuario()">💾 Salvar no Prontuário</button>
            <button type="button" class="btn-voltar" onclick="window.location.href='/painel-medico'">← Voltar ao Painel</button>
        </form>
    </div>
</div>

<script>
    const atendimentoId = '${req.params.id}';

    async function salvarProntuario() {
        const dados = {
            nome: document.getElementById('nome').value,
            nascimento: document.getElementById('nascimento').value,
            email: document.getElementById('email').value,
            cpf: document.getElementById('cpf').value,
            whatsapp: document.getElementById('whatsapp').value,
            doencas: document.getElementById('doencas').value,
            medicacao: document.getElementById('medicacao').value,
            tempoUso: document.getElementById('tempoUso').value,
            validadeReceita: document.getElementById('validadeReceita').value,
            queixa: document.getElementById('queixa').value,
            historia: document.getElementById('historia').value,
            conduta: document.getElementById('conduta').value,
            orientacoes: document.getElementById('orientacoes').value
        };

        try {
            const res = await fetch('/api/salvar-prontuario/' + atendimentoId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dados)
            });

            if (res.ok) {
                alert('✅ Prontuário salvo com sucesso!');
                window.location.href = '/painel-medico';
            } else {
                alert('❌ Erro ao salvar prontuário');
            }
        } catch(e) {
            alert('Erro: ' + e.message);
        }
    }
</script>
</body>
</html>
    `)
  } catch(e) {
    console.error(e)
    res.status(500).send('Erro ao carregar prontuário')
  }
})

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
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f2f5;padding:20px}
        .login-container{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;justify-content:center;align-items:center;background:linear-gradient(135deg,#1a6b8a 0%,#0d4f6b 100%);z-index:10}
        .login-card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
        .login-card h2{color:#1a6b8a;text-align:center;margin-bottom:24px;font-size:24px}
        .login-card input{width:100%;padding:12px 16px;margin-bottom:20px;border:1px solid #ddd;border-radius:8px;font-size:16px}
        .login-card button{width:100%;padding:12px;background:#1a6b8a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:16px;font-weight:bold}
        .login-card button:hover{background:#0d4f6b}
        .error-msg{color:#dc3545;text-align:center;margin-top:10px;display:none;font-weight:600}
        .painel-container{display:none}
        .header{background:linear-gradient(135deg,#1a6b8a 0%,#0d4f6b 100%);color:#fff;padding:20px 30px;border-radius:16px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
        .logout-btn{background:rgba(255,255,255,0.2);border:1px solid #fff;padding:10px 20px;border-radius:8px;cursor:pointer;color:#fff}
        .stats{display:flex;gap:15px;margin-bottom:20px;flex-wrap:wrap}
        .stat-card{background:#fff;padding:15px 25px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
        .stat-number{font-size:28px;font-weight:bold;color:#1a6b8a}
        .columns{display:flex;gap:20px;overflow-x:auto;min-height:500px}
        .column{flex:1;min-width:320px;background:#f8f9fa;border-radius:16px;padding:15px}
        .column h3{color:#1a6b8a;margin-bottom:15px;padding-bottom:10px;border-bottom:2px solid #dee2e6}
        .card{background:#fff;border-radius:12px;padding:15px;margin-bottom:15px;box-shadow:0 2px 8px rgba(0,0,0,0.1);transition:all .3s}
        .card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.15)}
        .card-id{font-size:12px;color:#6c757d;font-family:monospace;margin-bottom:8px}
        .card-name{font-weight:bold;font-size:16px;margin-bottom:5px}
        .card-time{font-size:11px;color:#999;margin-bottom:10px}
        .card-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
        .btn{padding:6px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
        .btn-prontuario{background:#17a2b8;color:#fff}
        .btn-aprovar{background:#28a745;color:#fff}
        .btn-recusar{background:#dc3545;color:#fff}
        .btn-pegar{background:#ffc107;color:#333}
        .btn-atender{background:#ffc107;color:#333}
        .empty-state{text-align:center;padding:40px;color:#999}
        .suporte-section{background:#fff;border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
        .suporte-section h3{color:#1a6b8a;margin-bottom:15px;display:flex;align-items:center;gap:10px}
        .suporte-card{background:#f8f9fa;border-left:4px solid #ffc107;border-radius:12px;padding:15px;margin-bottom:15px}
        .suporte-header{display:flex;justify-content:space-between;margin-bottom:10px}
        .suporte-nome{font-weight:bold;color:#333}
        .suporte-telefone{color:#666;font-size:12px}
        .suporte-mensagem{background:#fff;padding:10px;border-radius:8px;margin:10px 0;font-size:14px}
        .suporte-tempo{font-size:11px;color:#999;margin-bottom:10px}
        .suporte-actions{display:flex;gap:10px}
        @media(max-width:900px){.columns{flex-direction:column}.column{min-width:auto}}
    </style>
</head>
<body>
<div id="loginArea" class="login-container">
    <div class="login-card">
        <h2>🔐 Painel Médico</h2>
        <input type="password" id="senhaInput" placeholder="Digite sua senha" onkeypress="if(event.key==='Enter') fazerLogin()">
        <button onclick="fazerLogin()">Entrar</button>
        <div id="erroMsg" class="error-msg">❌ Senha incorreta!</div>
    </div>
</div>
<div id="painelArea" class="painel-container">
    <div class="header"><h1>📊 Doctor Prescreve - Painel Médico</h1><button class="logout-btn" onclick="logout()">Sair</button></div>
    <div class="stats" id="stats">Carregando...</div>
    <div class="suporte-section">
        <h3>📞 CHAMADOS DE SUPORTE</h3>
        <div id="suportesPendentes">Carregando...</div>
    </div>
    <div class="columns">
        <div class="column"><h3>⏳ FILA</h3><div id="filaColuna"><div class="empty-state">Carregando...</div></div></div>
        <div class="column"><h3>📋 EM ATENDIMENTO</h3><div id="atendimentoColuna"><div class="empty-state">Carregando...</div></div></div>
        <div class="column"><h3>✅ DECISÃO</h3><div id="decisaoColuna"><div class="empty-state">Carregando...</div></div></div>
    </div>
</div>
<script>
let token = localStorage.getItem('token');
let dadosAtendimentos = [];

async function fazerLogin() {
  const senha = document.getElementById('senhaInput').value;
  const erroMsg = document.getElementById('erroMsg');
  if (!senha) return;
  
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha })
    });
    const data = await res.json();
    
    if (data.token) {
      localStorage.setItem('token', data.token);
      document.getElementById('loginArea').style.display = 'none';
      document.getElementById('painelArea').style.display = 'block';
      carregarDados();
      erroMsg.style.display = 'none';
    } else {
      erroMsg.style.display = 'block';
    }
  } catch(e) {
    erroMsg.style.display = 'block';
  }
}

function logout() {
  localStorage.removeItem('token');
  document.getElementById('loginArea').style.display = 'flex';
  document.getElementById('painelArea').style.display = 'none';
  document.getElementById('senhaInput').value = '';
}

async function carregarDados() {
  try {
    const res = await fetch('/api/atendimentos');
    dadosAtendimentos = await res.json();
    
    const statsRes = await fetch('/api/estatisticas');
    const stats = await statsRes.json();
    
    document.getElementById('stats').innerHTML = \`
      <div class="stat-card"><div class="stat-number">\${stats.total || 0}</div><div>Total</div></div>
      <div class="stat-card"><div class="stat-number">\${stats.naFila || 0}</div><div>Na Fila</div></div>
      <div class="stat-card"><div class="stat-number">\${stats.aprovados || 0}</div><div>Aprovados</div></div>
      <div class="stat-card"><div class="stat-number">\${stats.recusados || 0}</div><div>Recusados</div></div>
    \`;
    
    renderizarColunas();
    carregarSuportes();
  } catch(e) {
    console.error(e);
  }
}

async function carregarSuportes() {
  try {
    const res = await fetch('/api/suporte/pendentes');
    const suportes = await res.json();
    let html = '';
    
    if (suportes.length === 0) {
      html = '<div class="empty-state">📭 Nenhum chamado pendente</div>';
    } else {
      suportes.forEach(s => {
        html += \`
          <div class="suporte-card" data-id="\${s.id}">
            <div class="suporte-header">
              <span class="suporte-nome">👤 \${s.nome || 'Paciente'}</span>
              <span class="suporte-telefone">📱 \${s.telefone}</span>
            </div>
            <div class="suporte-mensagem">💬 \${s.mensagem || 'Aguardando atendimento'}</div>
            <div class="suporte-tempo">⏱️ Há \${formatarTempo(s.criado_em)}</div>
            <div class="suporte-actions">
              <button class="btn btn-atender" onclick="atenderSuporte('\${s.id}', '\${s.telefone}', '\${s.nome || 'Paciente'}')">✓ Atender</button>
            </div>
          </div>
        \`;
      });
    }
    document.getElementById('suportesPendentes').innerHTML = html;
  } catch(e) {
    console.error(e);
  }
}

async function atenderSuporte(id, telefone, nome) {
  if (!confirm('Atender ' + nome + '? O paciente será notificado.')) return;
  
  try {
    await fetch('/api/suporte/atender/' + id, { method: 'POST' });
    
    await fetch('/api/enviar-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telefone: telefone,
        mensagem: '👨‍⚕️ Doctor Prescreve\\n\\nOlá! Um atendente já está analisando seu caso e falará com você em breve.'
      })
    });
    
    alert('✅ Paciente notificado!');
    carregarSuportes();
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

function formatarTempo(dataCriacao) {
  if (!dataCriacao) return 'agora';
  const criado = new Date(dataCriacao);
  const agora = new Date();
  const diffMin = Math.floor((agora - criado) / 60000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return diffMin + ' min';
  return Math.floor(diffMin / 60) + 'h';
}

function renderizarColunas() {
  const fila = dadosAtendimentos.filter(a => a.status === 'FILA' && a.pagamento);
  const emAtendimento = dadosAtendimentos.filter(a => a.status === 'EM_ATENDIMENTO');
  const aguardandoDecisao = dadosAtendimentos.filter(a => a.status === 'PRONTO_PARA_DECISAO');
  
  let filaHtml = '';
  if (fila.length === 0) {
    filaHtml = '<div class="empty-state">📭 Nenhum paciente na fila</div>';
  } else {
    fila.forEach(a => {
      filaHtml += \`
        <div class="card">
          <div class="card-id">ID: \${a.id.substring(0,8)}</div>
          <div class="card-name">\${a.paciente_nome || 'Paciente'}</div>
          <div class="card-time">⏱️ Na fila</div>
          <div class="card-actions">
            <button class="btn btn-pegar" onclick="pegarProximo()">🎯 Pegar Próximo</button>
          </div>
        </div>
      \`;
    });
  }
  document.getElementById('filaColuna').innerHTML = filaHtml;
  
  let atendimentoHtml = '';
  if (emAtendimento.length === 0) {
    atendimentoHtml = '<div class="empty-state">📋 Nenhum caso em atendimento</div>';
  } else {
    emAtendimento.forEach(a => {
      atendimentoHtml += \`
        <div class="card">
          <div class="card-id">ID: \${a.id.substring(0,8)}</div>
          <div class="card-name">\${a.paciente_nome || 'Paciente'}</div>
          <div class="card-time">👨‍⚕️ Em atendimento</div>
          <div class="card-actions">
            <button class="btn btn-prontuario" onclick="abrirProntuario('\${a.id}')">📋 Abrir Prontuário</button>
          </div>
        </div>
      \`;
    });
  }
  document.getElementById('atendimentoColuna').innerHTML = atendimentoHtml;
  
  let decisaoHtml = '';
  if (aguardandoDecisao.length === 0) {
    decisaoHtml = '<div class="empty-state">⚖️ Aguardando prontuários</div>';
  } else {
    aguardandoDecisao.forEach(a => {
      decisaoHtml += \`
        <div class="card">
          <div class="card-id">ID: \${a.id.substring(0,8)}</div>
          <div class="card-name">\${a.paciente_nome || 'Paciente'}</div>
          <div class="card-time">📝 Pronto para decisão</div>
          <div class="card-actions">
            <button class="btn btn-aprovar" onclick="aprovarConsulta('\${a.id}')">✅ Aprovar</button>
            <button class="btn btn-recusar" onclick="recusarConsulta('\${a.id}')">❌ Recusar</button>
          </div>
        </div>
      \`;
    });
  }
  document.getElementById('decisaoColuna').innerHTML = decisaoHtml;
}

async function pegarProximo() {
  try {
    const res = await fetch('/api/fila/pegar-proximo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medicoId: 'medico_' + Date.now() })
    });
    const data = await res.json();
    if (data.sucesso) {
      window.location.href = '/prontuario/' + data.atendimento.id;
    } else {
      alert('Fila vazia ou caso já em atendimento: ' + (data.motivo || ''));
      carregarDados();
    }
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

function abrirProntuario(id) {
  window.location.href = '/prontuario/' + id;
}

async function aprovarConsulta(id) {
  const orientacoes = prompt('Orientação médica (opcional):');
  if (!confirm('Confirmar aprovação? O paciente receberá a receita.')) return;
  
  try {
    const res = await fetch('/api/decisao/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'APROVAR', orientacoes: orientacoes || '' })
    });
    if (res.ok) {
      alert('✅ Consulta aprovada! Paciente receberá a receita.');
      carregarDados();
    } else {
      alert('❌ Erro ao aprovar');
    }
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

async function recusarConsulta(id) {
  const motivo = prompt('Motivo da recusa (opcional):');
  if (!confirm('Confirmar recusa? Paciente será notificado.')) return;
  
  try {
    const res = await fetch('/api/decisao/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao: 'RECUSAR', orientacoes: motivo || '' })
    });
    if (res.ok) {
      alert('❌ Consulta recusada!');
      carregarDados();
    } else {
      alert('❌ Erro ao recusar');
    }
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

const tokenCheck = localStorage.getItem('token');
if (tokenCheck) {
  document.getElementById('loginArea').style.display = 'none';
  document.getElementById('painelArea').style.display = 'block';
  carregarDados();
}

setInterval(() => {
  if (document.getElementById('painelArea').style.display !== 'none') {
    carregarDados();
  }
}, 30000);
</script>
</body>
</html>
  `)
})

// ========================
// PÁGINAS PÚBLICAS
// ========================
app.get('/healthz', (req, res) => res.json({ status: 'ok' }))
app.get('/success', (req, res) => res.send('<h1>✅ Pagamento Confirmado!</h1><p>Você receberá a resposta em breve.</p><a href="/painel-medico">Voltar</a>'))
app.get('/cancel', (req, res) => res.send('<h1>❌ Pagamento Cancelado</h1><a href="/">Voltar</a>'))
app.get('/', (req, res) => res.json({ service: 'Doctor Prescreve', status: 'online' }))

// ========================
// 🚀 INICIA SERVIDOR
// ========================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`)
  console.log(`🏥 Painel: ${BASE_URL}/painel-medico`)
  console.log(`📋 Prontuário: ${BASE_URL}/prontuario/:id`)
  console.log(`💳 Stripe Webhook: ${BASE_URL}/webhook/stripe\n`)
})

module.exports = app



// ===== ROTA DE TESTE TRIAGEM =====

// ===== HEALTHCHECK =====
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/triagem', (req, res) => {
  const { telefone, nome, sintomas } = req.body;

  let elegivel = true;

  if (!sintomas || sintomas.includes("dor forte") || sintomas.includes("febre")) {
    elegivel = false;
  }

  console.log('Triagem recebida:', telefone, nome, sintomas);

  res.json({
    status: 'ok',
    elegivel: elegivel,
    mensagem: elegivel
      ? 'Paciente elegível para renovação'
      : 'Paciente NÃO elegível - procurar atendimento presencial'
  });
});

