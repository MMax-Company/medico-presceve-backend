# Configuração da Integração Memed - Dr. Prescreve

Este documento descreve como configurar e utilizar a integração com a plataforma Memed para emissão de receitas digitais assinadas.

## 🚀 Fluxo de Funcionamento (Corrigido)

Para garantir o compliance e a validade jurídica (assinatura digital), a integração segue este fluxo:

1.  **Backend**: Gera o token de autenticação do prescritor (Dr. Max Vinicius).
2.  **Frontend**: Carrega o script `MdHub` da Memed usando o token gerado.
3.  **Médico**: Ao clicar em "Aprovar & Emitir Receita", o sistema abre a interface da Memed com os dados do paciente e medicamentos pré-preenchidos.
4.  **Finalização**: O médico revisa e finaliza a prescrição manualmente na interface da Memed.
5.  **Evento**: O sistema captura o evento de conclusão da Memed, aprova o atendimento no nosso banco de dados e salva o link da receita.

## ⚙️ Variáveis de Ambiente (.env)

Adicione as seguintes variáveis ao seu arquivo `.env` no servidor:

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

## 🛠️ Notas Importantes

- **Segurança**: Nunca versione o arquivo `.env` com as chaves reais.
- **MdHub**: A interface da Memed é carregada dinamicamente no frontend. Certifique-se de que o domínio onde o app está rodando está autorizado no painel da Memed.
- **Assinatura**: A assinatura digital é realizada exclusivamente dentro do módulo da Memed.

## 🧪 Testes

Para testar a conexão com a API:
```bash
node -e "require('./memed').testarConexao().then(console.log)"
```
