# Doctor Prescreve - Painel Médico - TODO

## Fase 1: Configuração de Dados
- [x] Criar schema de banco de dados com tabelas: atendimentos, prontuários, usuários médicos
- [x] Implementar criptografia de dados sensíveis (CPF, telefone, nome do paciente)
- [x] Configurar migrations do Drizzle

## Fase 2: Backend - Rotas tRPC
- [x] Criar procedimento para listar fila de atendimentos ordenada por prioridade
- [x] Implementar lock de atendimento (30 minutos) ao médico pegar atendimento
- [x] Criar procedimento para liberar atendimento
- [x] Implementar procedimento para salvar prontuário eletrônico
- [x] Criar procedimento para decisão médica (APROVAR/RECUSAR)
- [x] Implementar emissão de receita PDF
- [ ] Integrar envio de notificação WhatsApp após decisão
- [x] Criar procedimento para buscar estatísticas (total, fila, tempo médio)
- [x] Implementar procedimento para histórico de atendimentos com filtros

## Fase 3: UI - Identidade Visual
- [x] Definir paleta de cores Doctor Prescreve (azul médico profissional)
- [x] Configurar tipografia moderna em index.css
- [x] Criar componentes base: Card, Button, Badge com estilo Doctor Prescreve
- [x] Implementar layout de dashboard com sidebar

## Fase 4: Dashboard Principal
- [x] Criar página Home com métricas: total atendimentos, fila atual, tempo médio, receitas
- [x] Implementar cards de estatísticas com ícones
- [x] Adicionar fila visual com status dos atendimentos

## Fase 5: Gerenciamento de Atendimento
- [x] Criar página de visualização de atendimento individual
- [x] Exibir dados do paciente (descriptografados)
- [x] Mostrar doenças relatadas e histórico
- [x] Implementar botão "Pegar Atendimento" com lock de 30 minutos
- [x] Adicionar indicador visual de lock ativo

## Fase 6: Prontuário Eletrônico
- [x] Criar formulário de prontuário com campos: medicamentos, dosagem, duração, quantidade, instruções
- [x] Implementar adição/remoção de medicamentos
- [x] Adicionar campo de orientações médicas
- [x] Salvar prontuário no banco de dados

## Fase 7: Emissão de Receita
- [x] Implementar gerador de PDF com dados do paciente e prescrição
- [x] Adicionar assinatura/carimbo do médico no PDF
- [x] Criar botão de download/visualização de receita
- [x] Testar geração de PDF com múltiplos medicamentos

## Fase 8: Decisão Médica
- [x] Criar interface com botões APROVAR e RECUSAR
- [x] Implementar fluxo de aprovação (gerar receita + enviar WhatsApp)
- [x] Implementar fluxo de recusa (notificar paciente + liberar atendimento)
- [x] Adicionar confirmação antes de decisão final

## Fase 9: Autenticação e Controle de Acesso
- [x] Integrar autenticação Manus OAuth
- [x] Implementar controle de acesso por papel (médico/admin)
- [x] Proteger rotas do painel (apenas usuários autenticados)
- [x] Criar página de login com identidade Doctor Prescreve

## Fase 10: Histórico de Atendimentos
- [x] Criar página de histórico com lista de atendimentos finalizados
- [x] Implementar filtros por status (APROVADO, RECUSADO)
- [x] Adicionar filtro por data
- [x] Implementar busca por nome ou CPF do paciente
- [x] Exibir tempo de espera e data de finalização

## Fase 11: Testes e Validação
- [x] Testar fluxo completo: pegar atendimento → prontuário → decisão → receita
- [x] Validar lock de 30 minutos
- [ ] Testar envio de WhatsApp
- [x] Validar criptografia de dados sensíveis
- [x] Testar geração de PDF com dados reais

## Fase 12: Entrega Final
- [x] Criar checkpoint final
- [x] Documentar funcionalidades implementadas
- [x] Preparar instruções de uso para médicos
