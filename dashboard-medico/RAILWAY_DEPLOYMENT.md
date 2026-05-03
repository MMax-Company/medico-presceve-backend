# Deployment no Railway - Doctor Prescreve

## Pré-requisitos

1. Conta no [Railway.app](https://railway.app)
2. GitHub conectado ao Railway
3. Variáveis de ambiente configuradas

## Instruções de Deployment

### 1. Preparar o Repositório GitHub

```bash
# Clonar o repositório (se ainda não tiver)
git clone https://github.com/MMax-Company/doctor-prescreve-dashboard.git
cd doctor-prescreve-dashboard

# Adicionar todos os arquivos
git add .

# Fazer commit
git commit -m "Deploy Doctor Prescreve no Railway"

# Fazer push para main
git push origin main
```

### 2. Conectar ao Railway

1. Acesse [railway.app](https://railway.app)
2. Clique em "New Project"
3. Selecione "Deploy from GitHub"
4. Autorize o Railway a acessar seus repositórios
5. Selecione o repositório `doctor-prescreve-dashboard`
6. Escolha a branch `main`

### 3. Configurar Banco de Dados

1. No painel do Railway, clique em "Add Service"
2. Selecione "MySQL" ou "PostgreSQL"
3. Aguarde a criação do banco de dados
4. Copie a connection string fornecida

### 4. Configurar Variáveis de Ambiente

No painel do Railway, vá para "Variables" e adicione:

```
# Banco de Dados
DATABASE_URL=mysql://user:password@host:port/database

# OAuth Manus
VITE_APP_ID=seu_app_id
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://portal.manus.im

# JWT
JWT_SECRET=sua_secret_key_segura

# Owner
OWNER_NAME=seu_nome
OWNER_OPEN_ID=seu_open_id

# Forge API (Manus)
BUILT_IN_FORGE_API_URL=https://api.manus.im
BUILT_IN_FORGE_API_KEY=sua_api_key
VITE_FRONTEND_FORGE_API_URL=https://api.manus.im
VITE_FRONTEND_FORGE_API_KEY=sua_frontend_api_key

# Analytics (opcional)
VITE_ANALYTICS_ENDPOINT=seu_endpoint
VITE_ANALYTICS_WEBSITE_ID=seu_website_id

# App Info
VITE_APP_TITLE=Doctor Prescreve
VITE_APP_LOGO=https://seu-logo-url.png
```

### 5. Deploy

1. Railway detectará automaticamente o arquivo `railway.json`
2. Clique em "Deploy" no painel
3. Aguarde a conclusão do build e deployment

### 6. Acessar a Aplicação

Após o deployment, você receberá uma URL como:
```
https://doctor-prescreve-dashboard-production.up.railway.app
```

## Troubleshooting

### Build falha com erro de dependências

```bash
# Limpar cache e reinstalar
pnpm install --force
pnpm build
```

### Erro de conexão com banco de dados

1. Verifique se a variável `DATABASE_URL` está correta
2. Certifique-se de que o banco de dados está rodando
3. Teste a conexão localmente

### Erro de variáveis de ambiente

1. Verifique se todas as variáveis foram adicionadas
2. Reinicie o serviço no Railway
3. Verifique os logs em "Deployments"

## Logs e Monitoramento

Para visualizar os logs:
1. Acesse o painel do Railway
2. Clique no seu projeto
3. Selecione "Logs"
4. Filtre por data/hora conforme necessário

## Atualizações Futuras

Para fazer deploy de atualizações:

```bash
# Fazer alterações no código
git add .
git commit -m "Descrição das alterações"
git push origin main
```

Railway detectará automaticamente as mudanças e fará o redeploy.

## Suporte

Para mais informações sobre Railway, visite:
- [Documentação Railway](https://docs.railway.app)
- [Railway Community](https://community.railway.app)
