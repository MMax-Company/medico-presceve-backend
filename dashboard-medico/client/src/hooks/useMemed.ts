import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Hook para integração com a plataforma Memed
 * Fluxo correto:
 * 1. Backend gera token do prescritor
 * 2. Frontend carrega o MdHub com o token
 * 3. Médico finaliza a prescrição na interface Memed
 * 4. Frontend captura evento de finalização
 */
export function useMemed() {
  const tokenQuery = trpc.decisoes.obterTokenMemed.useQuery();
  const scriptLoaded = useRef(false);
  const [memedReady, setMemedReady] = useState(false);

  // Carregar o script da Memed
  useEffect(() => {
    if (scriptLoaded.current) return;
    if (!tokenQuery.data?.token) return;

    const script = document.createElement('script');
    script.src = 'https://integrations.memed.com.br/sinapse-prescricao/app.js';
    script.async = true;
    script.onload = () => {
      console.log('✅ Script da Memed carregado com sucesso');
      scriptLoaded.current = true;
      
      // Aguardar o MdHub estar pronto
      const checkMdHub = setInterval(() => {
        if ((window as any).MdHub) {
          clearInterval(checkMdHub);
          setMemedReady(true);
          console.log('✅ MdHub pronto para uso');
        }
      }, 100);
      
      // Timeout de 5 segundos
      setTimeout(() => clearInterval(checkMdHub), 5000);
    };
    script.onerror = () => {
      console.error('❌ Erro ao carregar script da Memed');
    };
    document.head.appendChild(script);

    return () => {
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, [tokenQuery.data?.token]);

  /**
   * Abre o módulo de prescrição da Memed
   * O médico finaliza a prescrição manualmente na interface Memed
   */
  const abrirModuloPrescricao = (dadosPaciente: {
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
      console.error('❌ MdHub não disponível');
      return;
    }

    if (!tokenQuery.data?.token) {
      console.error('❌ Token da Memed não disponível');
      return;
    }

    console.log('📝 Abrindo módulo de prescrição da Memed...');
    
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
    };

    // Enviar comando para abrir o módulo
    MdHub.command.send(
      'plataforma.prescricao',
      'openPrescriptionForm',
      payload
    );
  };

  /**
   * Registra listeners para eventos da Memed
   * Eventos importantes:
   * - prescriptionFinalized: Prescrição foi finalizada e assinada
   * - prescriptionError: Erro ao finalizar prescrição
   */
  const registrarEventos = (callbacks: {
    onPrescricaoFinalizada?: (data: any) => void;
    onErro?: (erro: any) => void;
  }) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.event?.subscribe) {
      console.error('❌ MdHub event não disponível');
      return;
    }

    // Evento: Prescrição finalizada e assinada
    if (callbacks.onPrescricaoFinalizada) {
      MdHub.event.subscribe(
        'plataforma.prescricao',
        'prescriptionFinalized',
        (data: any) => {
          console.log('✅ Prescrição finalizada na Memed:', data);
          callbacks.onPrescricaoFinalizada?.(data);
        }
      );
    }

    // Evento: Erro ao finalizar prescrição
    if (callbacks.onErro) {
      MdHub.event.subscribe(
        'plataforma.prescricao',
        'prescriptionError',
        (error: any) => {
          console.error('❌ Erro na prescrição:', error);
          callbacks.onErro?.(error);
        }
      );
    }

    console.log('✅ Listeners de eventos da Memed registrados');
  };

  /**
   * Desregistra listeners de eventos
   */
  const desregistrarEventos = () => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.event?.unsubscribe) return;

    MdHub.event.unsubscribe('plataforma.prescricao', 'prescriptionFinalized');
    MdHub.event.unsubscribe('plataforma.prescricao', 'prescriptionError');

    console.log('✅ Listeners de eventos da Memed removidos');
  };

  return {
    tokenMemed: tokenQuery.data?.token,
    isLoadingToken: tokenQuery.isLoading,
    memedReady,
    abrirModuloPrescricao,
    registrarEventos,
    desregistrarEventos,
  };
}
