# 📖 Tutorial: Importação e Configuração do N8N - Doctor Prescreve

Este guia substitui o tutorial em vídeo, fornecendo o passo a passo exato para colocar sua automação no ar.

---

## 📥 Passo 1: Importando o Workflow

1. **Abra o N8N**: Acesse sua instância no Railway.
2. **Crie um Novo Workflow**: Clique no botão **"+ New"** no canto superior direito.
3. **Importe o Arquivo**:
   - Clique no ícone de **engrenagem** ou nos **três pontinhos (⋮)** no canto superior direito.
   - Selecione **"Import from File"**.
   - Escolha o arquivo `workflow-n8n-completo.json` que você baixou.
4. **Visualize**: Você verá uma teia de nós (nodes) aparecer na tela. Clique em **"Save"** imediatamente.

---

## ⚙️ Passo 2: Configurando as Credenciais (Onde a mágica acontece)

Existem 3 pontos críticos que você precisa configurar manualmente:

### A. WhatsApp Business (Meta)
1. Localize o nó chamado **"WhatsApp Business"** ou **"HTTP Request"** (que aponta para a API da Meta).
2. Clique nele para abrir as configurações.
3. Insira seu **Access Token** (gerado no painel da Meta Developers).
4. Insira o seu **Phone Number ID**.
5. Teste o nó clicando em **"Execute Node"**.

### B. Banco de Dados (Supabase/PostgreSQL)
1. Localize os nós que salvam dados (ícone de banco de dados).
2. Clique em **"Credentials"** dentro do nó.
3. Selecione **"Create New"** e insira os dados do seu Supabase:
   - **Host**: `db.xxxx.supabase.co`
   - **Database**: `postgres`
   - **User**: `postgres`
   - **Password**: Sua senha do Supabase.
   - **Port**: `5432`

### C. Webhook do Typebot
1. Localize o primeiro nó chamado **"Webhook"**.
2. Clique nele e mude para a aba **"Production"**.
3. Copie a **URL de Produção** (ex: `https://n8n.seu-site.com/webhook/xxxx`).
4. **Vá ao Typebot**: No bloco de Webhook do seu bot, cole esta URL.

---

## 🚀 Passo 3: Ativação Final

1. No topo da tela do N8N, mude a chave de **"Inactive"** para **"Active"**.
2. **Teste Real**:
   - Abra seu Typebot.
   - Faça uma simulação de consulta.
   - Volte ao N8N e clique em **"Executions"** no menu lateral para ver se os dados chegaram.

---

## 🆘 Problemas Comuns

- **Erro 401 no WhatsApp**: Seu token da Meta expirou ou é temporário (gere um permanente).
- **Dados não salvam**: Verifique se as tabelas no Supabase têm os mesmos nomes das colunas enviadas pelo N8N.
- **Webhook não dispara**: Verifique se você salvou e publicou o Typebot após colar a URL.

---
*Dica: Mantenha o N8N sempre em modo "Active" para não perder nenhum atendimento de pacientes!*
