const express = require('express')
const app = express()
const PORT = process.env.PORT || 3002

app.get('/', (req, res) => {
  res.json({ status: 'ok', mensagem: 'Servidor rodando!' })
})

app.get('/estatisticas', (req, res) => {
  res.json({ total: 0, elegiveis: 0, pagos: 0, naFila: 0 })
})

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})