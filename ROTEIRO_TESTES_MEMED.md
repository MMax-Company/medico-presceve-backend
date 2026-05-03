# 🧪 Roteiro de Testes: Integração Memed - Dr. Prescreve

Este roteiro visa validar os 7 pontos críticos da integração e garantir que o fluxo de prescrição digital esteja operando corretamente em produção.

---

## 1. Pré-requisitos (Checklist de Ambiente)
Antes de iniciar os testes, confirme:
- [ ] Variáveis `MEMED_API_KEY` e `MEMED_SECRET_KEY` configuradas no `.env`.
- [ ] Domínio de produção (ex: `app.doctorprescreve.com.br`) liberado no painel da Memed.
- [ ] Certificado SSL (HTTPS) ativo no ambiente de teste/produção.
- [ ] Navegador com permissão para pop-ups (o widget da Memed pode abrir em modal ou nova aba).

---

## 2. Cenários de Teste

### Cenário A: Fluxo de Sucesso (Caminho Feliz)
**Objetivo:** Validar o ciclo completo desde a abertura até o salvamento da receita.
1. **Ação:** Acesse um atendimento pendente no painel médico.
2. **Ação:** Preencha o diagnóstico e adicione pelo menos um medicamento.
3. **Ação:** Clique em **"Aprovar & Emitir Receita"**.
4. **Esperado:** O botão deve mudar para "Abrindo Memed..." e o widget da Memed deve carregar com os dados do paciente e medicamentos pré-preenchidos.
5. **Ação:** Na interface da Memed, finalize a prescrição e realize a assinatura digital.
6. **Esperado:** Após a assinatura, o widget deve fechar automaticamente ou disparar o evento de conclusão.
7. **Esperado:** O sistema deve exibir um toast de sucesso: "Prescrição finalizada na Memed!".
8. **Esperado:** O atendimento deve sumir da fila de pendentes e o link da receita deve estar salvo no banco de dados.

### Cenário B: Validação de Token (Ponto Crítico 1 e 2)
**Objetivo:** Garantir que o backend está gerando tokens válidos.
1. **Ação:** Execute o comando de teste no terminal do servidor:
   ```bash
   node -e "require('./memed').testarConexao().then(console.log)"
   ```
2. **Esperado:** O retorno deve ser `true` e o log deve mostrar `✅ Conexão com Memed OK! Token válido`.
3. **Falha:** Se retornar `false`, verifique se as chaves no `.env` estão corretas e se o IP do servidor não está bloqueado.

### Cenário C: Captura de Evento e Identificação (Ponto 5, 6 e 7)
**Objetivo:** Garantir que a receita seja vinculada ao atendimento correto.
1. **Ação:** Abra o console do desenvolvedor no navegador (F12) antes de clicar em Aprovar.
2. **Ação:** Finalize uma receita na Memed.
3. **Esperado:** No console, deve aparecer o log: `✅ Evento prescription:completed capturado: { ... }`.
4. **Esperado:** Verifique se o log mostra o `atendimentoId` correto sendo enviado para a rota de salvamento.

### Cenário D: Falha de Carregamento (Ponto 3 e 4)
**Objetivo:** Validar o comportamento quando o script não carrega ou o domínio não está liberado.
1. **Ação:** Tente abrir a Memed em um domínio não autorizado ou sem internet.
2. **Esperado:** O sistema deve exibir um toast de erro: "Memed ainda está carregando..." ou "Erro ao carregar script".
3. **Ação:** Verifique se o botão de Aprovar volta ao estado normal para permitir nova tentativa.

---

## 3. Matriz de Erros e Soluções

| Problema | Causa Provável | Solução |
| :--- | :--- | :--- |
| Widget não abre | Domínio não liberado | Solicitar liberação do domínio no suporte da Memed. |
| Erro "Token Inválido" | Chaves `API_KEY` ou `SECRET_KEY` incorretas | Revisar as credenciais no arquivo `.env`. |
| Receita não salva no fim | Falha na rota `/api/receita` | Verificar logs do backend para erros de banco de dados. |
| Dados do paciente em branco | `atendimentoId` não enviado | Garantir que o hook `useMemed(atendimentoId)` recebeu o ID. |

---

## 4. Validação Final (Banco de Dados)
Após um teste de sucesso, execute no banco de dados:
```sql
SELECT id, status, receita_pdf_url FROM atendimentos WHERE id = 'ID_DO_TESTE';
```
**Resultado esperado:** `status` deve ser 'APROVADO' e `receita_pdf_url` deve conter o link da Memed.
