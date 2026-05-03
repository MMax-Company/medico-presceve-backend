import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Hook para integração com a plataforma Memed
 * Gerencia o carregamento do script e eventos da Memed
 */
export function useMemed() {
  const tokenQuery = trpc.decisoes.obterTokenMemed.useQuery();
  const scriptLoaded = useRef(false);

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
   * @param prescricaoId - ID da prescrição a visualizar
   */
  const abrirModuloPrescricao = (prescricaoId: string) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.command?.send) {
      console.error('❌ MdHub não disponível');
      return;
    }

    console.log(`📝 Abrindo módulo de prescrição: ${prescricaoId}`);
    MdHub.command.send(
      'plataforma.prescricao',
      'viewPrescription',
      prescricaoId
    );
  };

  /**
   * Cria uma nova prescrição na Memed
   * @param dadosPaciente - Dados do paciente
   * @param medicamentos - Lista de medicamentos
   */
  const criarPrescricao = (
    dadosPaciente: {
      nome: string;
      cpf: string;
      dataNascimento?: string;
      telefone?: string;
      email?: string;
    },
    medicamentos: Array<{
      nome: string;
      dosagem: string;
      duracao: string;
      quantidade: number;
      instrucoes?: string;
    }>
  ) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.command?.send) {
      console.error('❌ MdHub não disponível');
      return;
    }

    console.log('📝 Criando nova prescrição na Memed...');

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

    MdHub.command.send(
      'plataforma.prescricao',
      'createPrescription',
      payload
    );
  };

  /**
   * Registra listeners para eventos da Memed
   */
  const registrarEventos = (callbacks: {
    onPrescricaoImpresa?: (data: any) => void;
    onPrescricaoExcluida?: (data: any) => void;
    onErro?: (erro: any) => void;
  }) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.event?.subscribe) {
      console.error('❌ MdHub event não disponível');
      return;
    }

    // Evento: Prescrição impressa
    if (callbacks.onPrescricaoImpresa) {
      MdHub.event.subscribe(
        'plataforma.prescricao',
        'prescriptionPrinted',
        callbacks.onPrescricaoImpresa
      );
    }

    // Evento: Prescrição excluída
    if (callbacks.onPrescricaoExcluida) {
      MdHub.event.subscribe(
        'plataforma.prescricao',
        'prescriptionDeleted',
        callbacks.onPrescricaoExcluida
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

    MdHub.event.unsubscribe('plataforma.prescricao', 'prescriptionPrinted');
    MdHub.event.unsubscribe('plataforma.prescricao', 'prescriptionDeleted');

    console.log('✅ Listeners de eventos da Memed removidos');
  };

  /**
   * Configura dados do prescritor
   */
  const configurarPrescritor = (dados: {
    nome: string;
    crm: string;
    especialidade?: string;
    cidade?: string;
  }) => {
    if (typeof window === 'undefined') return;

    const MdHub = (window as any).MdHub;
    if (!MdHub?.config?.set) {
      console.error('❌ MdHub config não disponível');
      return;
    }

    console.log('⚙️ Configurando dados do prescritor na Memed...');

    MdHub.config.set({
      prescritor: {
        nome: dados.nome,
        crm: dados.crm,
        especialidade: dados.especialidade,
        cidade: dados.cidade,
      },
    });
  };

  return {
    tokenMemed: tokenQuery.data?.token,
    isLoadingToken: tokenQuery.isLoading,
    abrirModuloPrescricao,
    criarPrescricao,
    registrarEventos,
    desregistrarEventos,
    configurarPrescritor,
  };
}
