# Configuração Técnica Memed - Dr. Prescreve

Este documento detalha a implementação técnica da integração com a Memed, focada em compliance e captura de eventos.

## 🚀 Fluxo Técnico Implementado

1.  **Token Dinâmico**: O backend gera um token de prescritor via API da Memed.
2.  **Carregamento MdHub**: O frontend carrega o script `https://integrations.memed.com.br/sinapse-prescricao/app.js` injetando o `data-token` dinamicamente.
3.  **Abertura do Módulo**: Ao clicar em "Aprovar", o sistema pré-preenche os dados do paciente e medicamentos e abre o formulário da Memed via `MdHub.command.send`.
4.  **Captura de Evento**: O sistema escuta o evento `prescription:completed` disparado pelo widget da Memed após a assinatura.
5.  **Sincronização**: Ao capturar o evento, o frontend envia o link da receita para o backend via `salvarReceitaMemed`, que vincula ao atendimento e atualiza o status para `APROVADO`.

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

## ⚠️ Checklist de Produção

1.  **Domínio Liberado**: Você **DEVE** solicitar à Memed a liberação do domínio onde o sistema está hospedado (ex: `app.doctorprescreve.com.br`). Sem isso, o widget não carregará.
2.  **HTTPS**: A integração só funciona em ambientes seguros (HTTPS).
3.  **Chaves de Produção**: Certifique-se de usar as chaves de produção fornecidas pela Memed.

## 🛠️ Comandos de Teste

Testar geração de token no backend:
```bash
node -e "require('./memed').testarConexao().then(console.log)"
```

## 📂 Arquivos Modificados

- `memed.js`: Lógica de autenticação e cache de tokens.
- `dashboard-medico/server/routers.ts`: Novos endpoints `obterTokenMemed` e `salvarReceitaMemed`.
- `dashboard-medico/client/src/hooks/useMemed.ts`: Hook principal de integração e captura de eventos.
- `dashboard-medico/client/src/pages/Atendimento.tsx`: Interface de atendimento integrada.
