require('dotenv').config()

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const helmet = require('helmet')

const app = express()
const PORT = process.env.PORT || 3002

app.use(cors())
app.use(express.json())
app.use(helmet())

// ========================
// 🔐 CRIPTOGRAFIA
// ========================

const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex')

function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
}

function decrypt(text) {
  const [ivHex, data] = text.split(':')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
}

// ========================
// 🔐 AUTH
// ========================

const gerarToken = () => jwt.sign({ role: 'medico' }, process.env.JWT_SECRET)

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Não autorizado' })
  }
}

// ========================
// 💾 DB SIMPLES
// ========================

const fs = require('fs')
const path = require('path')

const DB_DIR = 'data'
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR)

const db = {
  salvar(at) {
    fs.writeFileSync(path.join(DB_DIR, `${at.id}.json`), JSON.stringify(at))
  },
  buscar(id) {
    const file = path.join(DB_DIR, `${id}.json`)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null
  }
}
app.post('/api/webhook/triagem', async (req, res) => {
  const { paciente, triagem } = req.body

  const id = crypto.randomUUID()

  const atendimento = {
    id,
    paciente_nome: encrypt(paciente.nome),
    condicao: encrypt(triagem.doencas),
    status: 'AGUARDANDO_PAGAMENTO',
    criado_em: new Date()
  }

  db.salvar(atendimento)

  res.json({ success: true, id })
})

// ========================
// 🚀 SERVER
// ========================

app.get('/', (req, res) => {
  res.json({ status: 'online', versao: '1.0' })
})

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`)
})
