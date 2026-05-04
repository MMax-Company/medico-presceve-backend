import { useEffect, useRef, useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Hook para integração com a plataforma Memed
 * 
 * Fluxo Técnico Correto:
 * 1. Backend gera token do prescritor via gerarTokenPrescritor()
 * 2. Frontend obtém token via obterTokenMemed query
 * 3. MdHub é carregado dinamicamente com data-token
 * 4. Médico finaliza prescrição na interface Memed
 * 5. Evento prescription:completed é capturado
 * 6. Frontend envia link da receita para backend via salvarReceitaMemed
 * 7. Backend salva link no prontuário e marca atendimento como APROVADO
 */
export function useMemed(atendimentoId?: string) {
  const tokenQuery = trpc.decisoes.obterTokenMemed.useQuery();
  const salvarReceitaMutation = trpc.decisoes.salvarReceitaMemed.useMutation();
  
  const scriptLoaded = useRef(false);
  const medhubInitialized = useRef(false);
  const [memedReady, setMemedReady] = useState(false);
  const [isOpeningModal, setIsOpeningModal] = useState(false);

  // Carregar o script da Memed dinamicamente com o token
  useEffect(() => {
    if (scriptLoaded.current) return;
    if (!tokenQuery.data?.token) return;

    console.log('📦 Carregando script da Memed com token dinâmico...');

    // Remover script anterior se existir
    const existingScript = document.getElementById('mdhub-script');
    if (existingScript) {
      existingScript.remove();
    }

    // Criar e injetar script com token como data attribute (Ponto 2 e 3)
    const script = document.createElement('script');
    script.id = 'mdhub-script';
    script.src = 'https://cdn.memed.com.br/widget/mdhub.js';
    script.async = true;
    script.dataset.token = tokenQuery.data.token;
    script.setAttribute('data-environment', 'production');

    script.onload = () => {
      console.log('✅ Script da Memed carregado com sucesso');
      scriptLoaded.current = true;

      // Aguardar MdHub estar disponível
      const checkMdHub = setInterval(() => {
        if ((window as any).MdHub) {
          clearInterval(checkMdHub);
          console.log('✅ MdHub pronto para uso');
          medhubInitialized.current = true;
          setMemedReady(true);

          // Registrar listeners de eventos
          registrarEventosInterno();
        }
      }, 100);

      // Timeout de 5 segundos
      setTimeout(() => clearInterval(checkMdHub), 5000);
    };

    script.onerror = () => {
      console.error('❌ Erro ao carregar script da Memed');
      scriptLoaded.current = false;
    };

    document.head.appendChild(script);

    return () => {
      // Não remover script ao desmontar para evitar recarregamentos desnecessários
    };
  }, [tokenQuery.data?.token]);

  /**
   * Registra listeners para eventos da Memed internamente
   */
  const registrarEventosInterno = useCallback(() => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.event?.add) {
      console.warn('⚠️ MdHub.event.add não disponível');
      return;
    }

    console.log('🎧 Registrando listeners de eventos da Memed...');

    // Evento: Prescrição foi finalizada e assinada (Ponto 5)
    MdHub.event.add('prescription:completed', async (data: any) => {
      console.log('✅ Evento prescription:completed capturado:', data);

      // Extrair dados da receita
      const receitaUrl = data?.prescription?.url || 
                        data?.url || 
                        data?.link || 
                        `https://integrations.memed.com.br/receita/${data?.id}`;
      
      const receitaId = data?.prescription?.id || data?.id;

      // Garantir atendimentoId (Ponto 7)
      const idParaSalvar = atendimentoId || (window as any).atendimentoAtual;

      // Salvar receita no backend (Ponto 6)
      if (idParaSalvar && receitaUrl) {
        try {
          await salvarReceitaMutation.mutateAsync({
            atendimentoId: idParaSalvar,
            receitaUrl,
            receitaId,
          });
          console.log('✅ Receita salva no backend com sucesso');
        } catch (error) {
          console.error('❌ Erro ao salvar receita no backend:', error);
        }
      }
    });

    // Requisito Obrigatório 3: Evento prescricaoImpressa
    MdHub.event.add('prescricaoImpressa', (data: any) => {
      console.log('✅ Evento prescricaoImpressa capturado:', data);
    });

    // Requisito Obrigatório 3: Evento prescricaoExcluida
    MdHub.event.add('prescricaoExcluida', (data: any) => {
      console.warn('⚠️ Evento prescricaoExcluida capturado:', data);
      // Aqui você pode adicionar lógica para invalidar a receita no seu banco
    });

    // Evento: Erro ao processar prescrição
    MdHub.event.add('prescription:error', (error: any) => {
      console.error('❌ Erro na Memed:', error);
    });

    // Evento: Modal foi fechado
    MdHub.event.add('modal:closed', () => {
      console.log('ℹ️ Modal da Memed foi fechado');
      setIsOpeningModal(false);
    });

    console.log('✅ Listeners de eventos registrados');
  }, [atendimentoId, salvarReceitaMutation]);

  /**
   * Abre o módulo de prescrição da Memed
   * Médico finaliza a prescrição manualmente na interface Memed
   */
  const abrirModuloPrescricao = useCallback((dadosPaciente: {
    nome: string;
    cpf: string;
    dataNascimento?: string;
    telefone?: string;
    email?: string;
  }, medicamentos: Array<{
    nome: string;
    dosagem: string;
    duracao: string;
    quantidade: number;
    instrucoes?: string;
  }>) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.command?.send) {
      console.error('❌ MdHub.command.send não disponível');
      return;
    }

    if (!tokenQuery.data?.token) {
      console.error('❌ Token da Memed não disponível');
      return;
    }

    if (!medhubInitialized.current) {
      console.error('❌ MdHub não foi inicializado corretamente');
      return;
    }

    console.log('📝 Abrindo módulo de prescrição da Memed...');
    setIsOpeningModal(true);

    // Garantir atendimentoId global (Ponto 7)
    if (atendimentoId) {
      (window as any).atendimentoAtual = atendimentoId;
    }

    // Preparar dados para o MdHub
    const payload = {
      paciente: {
        nome: dadosPaciente.nome,
        cpf: dadosPaciente.cpf,
        data_nascimento: dadosPaciente.dataNascimento || '01/01/1980',
        telefone: dadosPaciente.telefone || '',
        email: dadosPaciente.email || '',
      },
      medicamentos: medicamentos.map(med => ({
        nome: med.nome,
        dosagem: med.dosagem,
        duracao: med.duracao,
        quantidade: med.quantidade,
        instrucoes: med.instrucoes || 'Conforme orientação médica',
      })),
      atendimentoId: atendimentoId, // Garantir que atendimentoId está presente
    };

    try {
      // Validar se o MdHub está realmente pronto
      if (!(window as any).MdHub?.is_ready) {
        console.warn('⚠️ MdHub não está totalmente pronto, tentando inicializar...');
      }

      // Requisito Obrigatório 2: Configurando o Paciente via setPaciente
      MdHub.command.send('plataforma.prescricao', 'setPaciente', payload.paciente);

      // Enviar comando para abrir o módulo
      MdHub.command.send(
        'plataforma.prescricao',
        'openPrescriptionForm',
        payload
      );
      console.log('✅ Comando enviado para abrir prescrição');
      
      // Timeout de segurança: se não abrir em 10s, avisar o usuário
      setTimeout(() => {
        if (isOpeningModal) {
          console.warn('⚠️ O widget da Memed está demorando para responder.');
        }
      }, 10000);

    } catch (error) {
      console.error('❌ Erro ao abrir prescrição:', error);
      setIsOpeningModal(false);
      // Fallback: Alertar erro crítico
      alert('Erro crítico ao abrir Memed. Verifique se o bloqueador de pop-ups está ativo ou use o modo de contingência.');
    }
  }, [tokenQuery.data?.token, atendimentoId, isOpeningModal]);

  /**
   * Desregistra listeners de eventos
   */
  const desregistrarEventos = useCallback(() => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.event?.remove) return;

    MdHub.event.remove('prescription:completed');
    MdHub.event.remove('prescricaoImpressa');
    MdHub.event.remove('prescricaoExcluida');
    MdHub.event.remove('prescription:error');
    MdHub.event.remove('modal:closed');

    console.log('✅ Listeners de eventos removidos');
  }, []);

  return {
    tokenMemed: tokenQuery.data?.token,
    isLoadingToken: tokenQuery.isLoading,
    memedReady,
    isOpeningModal,
    abrirModuloPrescricao,
    desregistrarEventos,
    isSavingReceipt: salvarReceitaMutation.isPending,
  };
}
