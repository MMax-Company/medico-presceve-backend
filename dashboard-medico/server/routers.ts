import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { z } from "zod";
import {
  obterFilaOrdenada,
  tentarPegarAtendimento,
  liberarAtendimento,
  atualizarStatusAtendimento,
  obterAtendimento,
  salvarProntuario,
  obterProntuario,
  obterEstatisticas,
  decrypt,
  encrypt,
} from "./db";
import { TRPCError } from "@trpc/server";
import { obterTokenParaFrontend } from "../../memed";

// Procedimento apenas para médicos
const medicoProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'medico' && ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Apenas médicos podem acessar' });
  }
  return next({ ctx });
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Rotas de Atendimentos
  atendimentos: router({
    // Obter fila de atendimentos
    obterFila: medicoProcedure.query(async () => {
      const fila = await obterFilaOrdenada();
      return fila.map(at => ({
        ...at,
        pacienteNome: decrypt(at.pacienteNomeEncrypted),
        pacienteCpf: decrypt(at.pacienteCpfEncrypted),
        pacienteTelefone: decrypt(at.pacienteTelefoneEncrypted),
        doencas: decrypt(at.doencasEncrypted),
      }));
    }),

    // Pegar próximo atendimento
    pegarProximo: medicoProcedure.mutation(async ({ ctx }) => {
      const fila = await obterFilaOrdenada();
      if (fila.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Fila vazia' });
      }

      const proximo = fila[0];
      const resultado = await tentarPegarAtendimento(proximo.id, ctx.user.id.toString());

      if (!resultado.sucesso) {
        throw new TRPCError({ code: 'CONFLICT', message: resultado.motivo });
      }

      const at = resultado.atendimento;
      return {
        ...at,
        pacienteNome: decrypt(at!.pacienteNomeEncrypted),
        pacienteCpf: decrypt(at!.pacienteCpfEncrypted),
        pacienteTelefone: decrypt(at!.pacienteTelefoneEncrypted),
        pacienteEmail: decrypt(at!.pacienteEmailEncrypted),
        doencas: decrypt(at!.doencasEncrypted),
      };
    }),

    // Obter atendimento por ID
    obter: medicoProcedure.input(z.string()).query(async ({ input }) => {
      const at = await obterAtendimento(input);
      if (!at) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Atendimento não encontrado' });
      }

      return {
        ...at,
        pacienteNome: decrypt(at.pacienteNomeEncrypted),
        pacienteCpf: decrypt(at.pacienteCpfEncrypted),
        pacienteTelefone: decrypt(at.pacienteTelefoneEncrypted),
        pacienteEmail: decrypt(at.pacienteEmailEncrypted),
        pacienteNascimento: decrypt(at.pacienteNascimentoEncrypted),
        doencas: decrypt(at.doencasEncrypted),
      };
    }),

    // Liberar atendimento
    liberar: medicoProcedure.input(z.string()).mutation(async ({ input }) => {
      const sucesso = await liberarAtendimento(input);
      if (!sucesso) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Erro ao liberar atendimento' });
      }
      return { sucesso: true };
    }),

    // Obter estatísticas
    obterEstatisticas: medicoProcedure.query(async () => {
      return await obterEstatisticas();
    }),

    // Calcular tempo médio de espera
    obterTempoMedioEspera: medicoProcedure.query(async () => {
      const fila = await obterFilaOrdenada();
      if (fila.length === 0) return 0;

      const tempos = fila.map(at => {
        const pagamentoEm = at.pagamentoEm ? new Date(at.pagamentoEm).getTime() : new Date(at.criadoEm).getTime();
        const agora = Date.now();
        return Math.floor((agora - pagamentoEm) / 60000);
      });

      return Math.floor(tempos.reduce((a, b) => a + b, 0) / tempos.length);
    }),

    // Obter histórico de atendimentos
    obterHistorico: medicoProcedure.query(async () => {
      return [];
    }),
  }),

  // Rotas de Prontuários
  prontuarios: router({
    // Obter prontuário
    obter: medicoProcedure.input(z.string()).query(async ({ input }) => {
      return await obterProntuario(input);
    }),

    // Salvar prontuário
    salvar: medicoProcedure
      .input(
        z.object({
          atendimentoId: z.string(),
          medicamentos: z.array(
            z.object({
              id: z.string().optional(),
              nome: z.string(),
              dosagem: z.string(),
              duracao: z.string(),
              quantidade: z.number(),
              instrucoes: z.string().optional(),
            })
          ),
          orientacoes: z.string().optional(),
          diagnostico: z.string().optional(),
          observacoes: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const prontuario = await salvarProntuario(input.atendimentoId, {
          medicamentos: input.medicamentos,
          orientacoes: input.orientacoes,
          diagnostico: input.diagnostico,
          observacoes: input.observacoes,
        });

        if (!prontuario) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Erro ao salvar prontuário' });
        }

        return prontuario;
      }),
  }),

  // Rotas de Decisões Médicas
  decisoes: router({
    // Aprovar atendimento
    aprovar: medicoProcedure
      .input(
        z.object({
          atendimentoId: z.string(),
          orientacoes: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const atendimento = await obterAtendimento(input.atendimentoId);
        if (!atendimento) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Atendimento não encontrado' });
        }

        const prontuario = await obterProntuario(input.atendimentoId);
        
        // Descriptografar dados para a Memed
        const dadosAtendimento = {
          ...atendimento,
          pacienteNome: decrypt(atendimento.pacienteNomeEncrypted),
          pacienteCpf: decrypt(atendimento.pacienteCpfEncrypted),
          pacienteTelefone: decrypt(atendimento.pacienteTelefoneEncrypted),
          pacienteEmail: decrypt(atendimento.pacienteEmailEncrypted),
          pacienteNascimento: decrypt(atendimento.pacienteNascimentoEncrypted),
          medicamentos: prontuario?.medicamentos || [],
          orientacoes: input.orientacoes || prontuario?.orientacoes || '',
        };

        // O status agora é atualizado após a finalização na Memed via Frontend
        // Mas permitimos aprovação manual se necessário
        const sucesso = await atualizarStatusAtendimento(input.atendimentoId, 'APROVADO');
        if (!sucesso) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Erro ao aprovar atendimento' });
        }

        return { 
          sucesso: true, 
          mensagem: 'Atendimento aprovado com sucesso'
        };
      }),
    // Obter token da Memed para o frontend
    obterTokenMemed: medicoProcedure.query(async () => {
      try {
        const token = await obterTokenParaFrontend();
        return { token };
      } catch (error) {
        throw new TRPCError({ 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Erro ao obter token da Memed' 
        });
      }
    }),

    // Salvar link da receita gerada pela Memed
    salvarReceitaMemed: medicoProcedure
      .input(
        z.object({
          atendimentoId: z.string(),
          receitaUrl: z.string(),
          receitaId: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const sucesso = await salvarProntuario(input.atendimentoId, {
          receitaPdfUrl: input.receitaUrl,
        });

        if (!sucesso) {
          throw new TRPCError({ 
            code: 'INTERNAL_SERVER_ERROR', 
            message: 'Erro ao salvar link da receita' 
          });
        }

        // Também atualiza o status do atendimento para APROVADO se ainda não estiver
        await atualizarStatusAtendimento(input.atendimentoId, 'APROVADO');

        return { sucesso: true };
      }),

    // Recusar atendimento
    recusar: medicoProcedure
      .input(z.string())
      .mutation(async ({ input }) => {
        const sucesso = await atualizarStatusAtendimento(input, 'RECUSADO');
        if (!sucesso) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Erro ao recusar atendimento' });
        }

        return { sucesso: true, mensagem: 'Atendimento recusado' };
      }),

    // Obter URL da receita
    obterReceita: medicoProcedure
      .input(z.string())
      .query(async ({ input }) => {
        const prontuario = await obterProntuario(input);
        if (!prontuario?.receitaPdfUrl) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Receita não encontrada' });
        }
        return { url: prontuario.receitaPdfUrl };
      }),
  }),
});

export type AppRouter = typeof appRouter;
