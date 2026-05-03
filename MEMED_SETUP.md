# Configuração Técnica Memed - Dr. Prescreve (Checklist Rigoroso)

Este documento detalha a implementação técnica da integração com a Memed, focada nos 7 pontos críticos para funcionamento em produção.

## ✅ Checklist de Implementação (Os 7 Pontos)

1.  **Token Real do Prescritor**: Implementado no backend via `gerarTokenPrescritor()`. A rota `obterTokenMemed` garante que o frontend receba um token válido.
2.  **Frontend com Token Dinâmico**: O hook `useMemed` consome o token e o injeta via `script.dataset.token = token`.
3.  **Script MdHub Correto**: Utilizando o CDN oficial: `https://cdn.memed.com.br/widget/mdhub.js`.
4.  **Domínio Liberado (CRÍTICO)**: Você **DEVE** autorizar o domínio do seu app (ex: `app.doctorprescreve.com.br`) no painel da Memed. Sem isso, o widget não carrega.
5.  **Captura de Evento `prescription:completed`**: Implementado via `MdHub.event.add("prescription:completed", ...)`. Este é o coração da integração.
6.  **Salvamento no Backend**: Rota `salvarReceitaMemed` (POST) vincula o link da receita ao atendimento e marca como `APROVADO`.
7.  **Garantia de `atendimentoId`**: O ID é amarrado globalmente em `window.atendimentoAtual` antes de abrir o widget, evitando perda de vínculo.

## 🚀 Fluxo de Funcionamento

- **Médico** clica em "Aprovar & Emitir Receita".
- **Sistema** salva o prontuário e abre o widget da Memed com dados pré-preenchidos.
- **Médico** finaliza e assina a prescrição na interface da Memed.
- **Widget** dispara o evento `prescription:completed`.
- **Sistema** captura o link da receita, envia para o backend e finaliza o atendimento.

## ⚙️ Variáveis de Ambiente (.env)

```env
# Credenciais da API Memed
MEMED_API_KEY=sua_api_key_aqui
MEMED_SECRET_KEY=sua_secret_key_aqui
MEMED_API_URL=https://integrations.api.memed.com.br/v1

# Dados do Prescritor (Dr. Max Vinicius)
MEMED_PRESCRITOR_EXTERNAL_ID=dr_max_vinicius_001
MEMED_PRESCRITOR_NOME=Max
MEMED_PRESCRITOR_SOBRENOME=Vinicius Ferreira Matos
MEMED_PRESCRITOR_CPF=01739134150
MEMED_PRESCRITOR_BOARD_NUMBER=163032
MEMED_PRESCRITOR_BOARD_STATE=SP
MEMED_PRESCRITOR_EMAIL=dr.max.vinicius.cg@outlook.com
MEMED_PRESCRITOR_TELEFONE=11968123900
MEMED_PRESCRITOR_DATA_NASC=1988-02-09
```

## 🧪 Teste de Conexão (Backend)
```bash
node -e "require('./memed').testarConexao().then(console.log)"
```
