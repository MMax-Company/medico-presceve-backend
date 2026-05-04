FROM node:22-alpine AS base

# Install pnpm globally
RUN npm install -g pnpm

# --- Dashboard Build Stage ---
FROM base AS dashboard-builder
WORKDIR /app/dashboard-medico
# O dashboard usa pnpm
COPY dashboard-medico/package.json dashboard-medico/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY dashboard-medico/ .
RUN pnpm build

# --- Final Production Stage ---
FROM base
WORKDIR /app

# O backend usa npm (package-lock.json)
COPY package*.json ./
RUN npm install --production

# Copiar código do Backend
COPY . .

# Copiar o build do Dashboard para dentro da pasta do Backend
COPY --from=dashboard-builder /app/dashboard-medico/dist ./dashboard-medico/dist

# Criar diretório de dados para receitas locais
RUN mkdir -p data

# Expose the port that Railway uses (default 3002 or the injected one)
EXPOSE 3002

CMD ["node", "server.js"]
