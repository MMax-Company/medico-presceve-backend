# Build stage for Dashboard
FROM node:22-alpine AS dashboard-builder
WORKDIR /app/dashboard-medico
COPY dashboard-medico/package.json dashboard-medico/pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY dashboard-medico/ .
RUN pnpm build

# Final production stage
FROM node:22-alpine
WORKDIR /app

# Instalar pnpm globalmente para o backend se necessário (opcional)
RUN npm install -g pnpm

# Copiar arquivos do Backend
COPY package*.json ./
COPY .npmrc ./
RUN npm install --legacy-peer-deps --production

# Copiar código do Backend
COPY . .

# Copiar o build do Dashboard para dentro da pasta do Backend
COPY --from=dashboard-builder /app/dashboard-medico/dist ./dashboard-medico/dist

# Criar diretório de dados para receitas locais
RUN mkdir -p data

# Expor a porta que o Railway usa (padrão 3002 ou a injetada)
EXPOSE 3002

CMD ["node", "server.js"]
