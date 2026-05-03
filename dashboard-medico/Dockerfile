# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar pnpm
RUN npm install -g pnpm

# Copiar arquivos de dependências
COPY package.json pnpm-lock.yaml ./

# Instalar dependências
RUN pnpm install --frozen-lockfile

# Copiar código fonte
COPY . .

# Build do projeto
RUN pnpm build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Instalar pnpm
RUN npm install -g pnpm

# Copiar package.json
COPY package.json pnpm-lock.yaml ./

# Instalar dependências de produção
RUN pnpm install --frozen-lockfile --prod

# Copiar arquivos buildados do stage anterior
COPY --from=builder /app/dist ./dist

# Expor porta
EXPOSE 3000

# Comando para iniciar
CMD ["pnpm", "start"]
