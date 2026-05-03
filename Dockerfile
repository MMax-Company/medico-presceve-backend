FROM node:22-alpine

WORKDIR /app

# Copiar package files primeiro (cache de dependências)
COPY package*.json ./
COPY .npmrc ./

# Instalar dependências de produção
RUN npm install --legacy-peer-deps --production

# Copiar código fonte
COPY . .

# Criar diretório de dados para receitas locais
RUN mkdir -p data

# Railway injeta PORT dinamicamente via variável de ambiente
EXPOSE 3002

CMD ["node", "server.js"]
