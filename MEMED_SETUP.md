# Configuração da Integração Memed - Doctor Prescreve

## Chaves de Produção da Memed

Para utilizar a integração com a Memed em **produção**, você precisa configurar as seguintes variáveis de ambiente no arquivo `.env`:

### Variáveis Obrigatórias

```env
# ============================================
# MEMED - CHAVES DE PRODUÇÃO
# ============================================

# URL da API Memed (Produção)
MEMED_API_URL=https://integrations.api.memed.com.br/v1

# Chaves de Autenticação (obtidas no painel da Memed)
MEMED_API_KEY=seu_api_key_aqui
MEMED_SECRET_KEY=seu_secret_key_aqui

# ============================================
# DADOS DO PRESCRITOR (Dr. Max Vinicius)
# ============================================

# Identificador externo único do prescritor
MEMED_PRESCRITOR_EXTERNAL_ID=dr_max_vinicius_001

# Dados Pessoais
MEMED_PRESCRITOR_NOME=Max
MEMED_PRESCRITOR_SOBRENOME=Vinicius Ferreira Matos
MEMED_PRESCRITOR_CPF=01739134150
MEMED_PRESCRITOR_EMAIL=dr.max.vinicius.cg@outlook.com
MEMED_PRESCRITOR_TELEFONE=11968123900
MEMED_PRESCRITOR_SEXO=M
MEMED_PRESCRITOR_DATA_NASC=09/02/1988

# Dados Profissionais
MEMED_PRESCRITOR_BOARD_CODE=CRM
MEMED_PRESCRITOR_BOARD_NUMBER=163032
MEMED_PRESCRITOR_BOARD_STATE=SP

# Localização (IDs da API da Memed)
# Consulte: https://integrations.api.memed.com.br/v1/cidades
MEMED_CIDADE_ID=5273

# Especialidade (IDs da API da Memed)
# Consulte: https://integrations.api.memed.com.br/v1/especialidades
MEMED_ESPECIALIDADE_ID=45
```

## Como Obter as Chaves

1. Acesse o painel da Memed: https://memed.com.br
2. Navegue até **Configurações > Integrações**
3. Procure por **Chaves de Produção**
4. Copie a `API_KEY` e `SECRET_KEY`
5. Cole nos campos acima no arquivo `.env`

## Teste de Conexão

Após configurar as variáveis, execute:

```bash
npm run test:memed
```

Isso validará se as credenciais estão corretas e se a conexão com a Memed está funcionando.

## Fluxo de Integração

Quando um médico aprova um atendimento no painel:

1. **Backend** valida os dados do paciente e medicamentos
2. **Backend** envia os dados para a Memed via API
3. **Memed** pré-preenche a prescrição com os dados
4. **Frontend** carrega o script da Memed e exibe a interface
5. **Médico** revisa e assina digitalmente a prescrição
6. **Memed** gera a receita digital assinada
7. **Sistema** salva o link da receita e envia para o paciente via WhatsApp

## Endpoints Utilizados

- **Autenticação**: `POST /sinapse-prescricao/usuarios`
- **Obter Token**: `GET /sinapse-prescricao/usuarios/{ID}`
- **Criar Prescrição**: Via Frontend (MdHub)
- **Recuperar Receita**: `GET /prescricoes/{id}/get-digital-prescription-link`
- **Salvar PDF**: `GET /prescricoes/{id}/url-document/full`

## Segurança

⚠️ **IMPORTANTE**: Nunca compartilhe suas chaves de produção. Elas devem estar apenas no arquivo `.env` do servidor, nunca no código ou repositório público.

## Suporte

Para dúvidas sobre a integração, consulte:
- Documentação Memed: https://doc.memed.com.br
- Email de Suporte: suporte@memed.com.br
