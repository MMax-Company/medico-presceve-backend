const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, 'db.json')

if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ atendimentos: [] }, null, 2))
}

function readDB() {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function writeDB(data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

module.exports = {
    getAtendimentos: () => readDB().atendimentos,
    saveAtendimentos: (atendimentos) => {
        writeDB({ atendimentos })
    }
}