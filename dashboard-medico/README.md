# 🏥 Doctor Prescreve - Painel Médico

Painel médico profissional para gerenciamento de atendimentos, prontuários eletrônicos e emissão de receitas.

## 🎯 Funcionalidades

### Dashboard
- Métricas em tempo real (total atendimentos, fila, tempo médio, receitas)
- Visualização de status dos atendimentos
- Ações rápidas para gerenciamento

### Gerenciamento de Fila
- Fila ordenada por prioridade
- Status: FILA, EM_ATENDIMENTO, APROVADO, RECUSADO
- Lock de 30 minutos para evitar conflito entre médicos

### Prontuário Eletrônico
- Registro de medicamentos (nome, dosagem, duração, quantidade)
- Orientações médicas
- Histórico de atendimentos

### Emissão de Receita
- Geração de PDF com dados do paciente
- Assinatura do médico
- Download/visualização

### Segurança
- Autenticação OAuth
- Criptografia de dados sensíveis
- Controle de acesso por papel

## 🚀 Deploy no Railway

Veja [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md) para instruções completas.

### Variáveis de Ambiente Necessárias

\`\`\`
DATABASE_URL=mysql://user:password@host:port/database
VITE_APP_ID=seu_app_id
OAUTH_SERVER_URL=https://api.manus.im
JWT_SECRET=sua_secret_key
\`\`\`

## 📦 Stack Tecnológico

- **Frontend**: React 19 + Tailwind CSS 4
- **Backend**: Express 4 + tRPC 11
- **Database**: MySQL/TiDB
- **Auth**: Manus OAuth
- **PDF**: PDFKit

## 🧪 Testes

\`\`\`bash
pnpm test
\`\`\`

## 📝 Desenvolvimento

\`\`\`bash
# Instalar dependências
pnpm install

# Rodar em desenvolvimento
pnpm dev

# Build para produção
pnpm build

# Iniciar em produção
pnpm start
\`\`\`

## 📄 Licença

Propriedade da Doctor Prescreve
