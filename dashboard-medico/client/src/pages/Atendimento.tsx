import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, Plus, Trash2, Clock, FileText } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRoute, useLocation } from "wouter";
import { useState } from "react";
import { toast } from "sonner";
import { useMemed } from "@/hooks/useMemed";

interface Medicamento {
  id?: string;
  nome: string;
  dosagem: string;
  duracao: string;
  quantidade: number;
  instrucoes?: string;
}

export default function Atendimento() {
  const { user, isAuthenticated } = useAuth();
  const [, params] = useRoute("/atendimento/:id");
  const [, setLocation] = useLocation();
  const atendimentoId = params?.id as string;

  // State
  const [medicamentos, setMedicamentos] = useState<Medicamento[]>([]);
  const [orientacoes, setOrientacoes] = useState("");
  const [diagnostico, setDiagnostico] = useState("");
  const [novoMedicamento, setNovoMedicamento] = useState<Medicamento>({
    nome: "",
    dosagem: "",
    duracao: "",
    quantidade: 1,
    instrucoes: "",
  });
  
  // Integração Memed
  const memed = useMemed();

  // Queries
  const atendimentoQuery = trpc.atendimentos.obter.useQuery(atendimentoId, {
    enabled: isAuthenticated && !!atendimentoId,
  });

  const prontuarioQuery = trpc.prontuarios.obter.useQuery(atendimentoId, {
    enabled: isAuthenticated && !!atendimentoId,
  });

  // Mutations
  const salvarProntuarioMutation = trpc.prontuarios.salvar.useMutation({
    onSuccess: () => {
      toast.success("Prontuário salvo com sucesso");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao salvar prontuário");
    },
  });

  const aprovarMutation = trpc.decisoes.aprovar.useMutation({
    onSuccess: () => {
      toast.success("Atendimento aprovado");
      setLocation("/");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao aprovar");
    },
  });

  const recusarMutation = trpc.decisoes.recusar.useMutation({
    onSuccess: () => {
      toast.success("Atendimento recusado");
      setLocation("/");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao recusar");
    },
  });

  if (atendimentoQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const atendimento = atendimentoQuery.data;
  const prontuario = prontuarioQuery.data;

  if (!atendimento) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="mb-4 text-2xl font-bold">Atendimento não encontrado</h1>
          <Button onClick={() => setLocation("/")} variant="outline">
            Voltar ao Dashboard
          </Button>
        </div>
      </div>
    );
  }

  const handleAdicionarMedicamento = () => {
    if (!novoMedicamento.nome || !novoMedicamento.dosagem) {
      toast.error("Preencha nome e dosagem do medicamento");
      return;
    }
    setMedicamentos([
      ...medicamentos,
      { ...novoMedicamento, id: Date.now().toString() },
    ]);
    setNovoMedicamento({
      nome: "",
      dosagem: "",
      duracao: "",
      quantidade: 1,
      instrucoes: "",
    });
  };

  const handleRemoverMedicamento = (id?: string) => {
    setMedicamentos(medicamentos.filter((m) => m.id !== id));
  };

  const handleSalvarProntuario = () => {
    salvarProntuarioMutation.mutate({
      atendimentoId,
      medicamentos,
      orientacoes,
      diagnostico,
    });
  };

  const handleAprovar = async () => {
    // Validar dados obrigatórios
    if (medicamentos.length === 0) {
      toast.error('Adicione pelo menos um medicamento');
      return;
    }

    // Salvar prontuário primeiro
    await salvarProntuarioMutation.mutateAsync({
      atendimentoId,
      medicamentos,
      orientacoes,
      diagnostico,
    });

    // Depois aprovar (que dispara a emissão da receita na Memed)
    aprovarMutation.mutate({
      atendimentoId,
      orientacoes,
    });
  };

  const handleRecusar = () => {
    recusarMutation.mutate(atendimentoId);
  };

  const handleVisualizarReceita = () => {
    if (memed.tokenMemed && atendimento.id) {
      memed.abrirModuloPrescricao(atendimento.id);
    } else {
      toast.error('Token da Memed não disponível');
    }
  };

  const tempoRestante = atendimento.lockedUntil
    ? Math.max(
        0,
        Math.floor(
          (new Date(atendimento.lockedUntil).getTime() - Date.now()) / 60000
        )
      )
    : 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="doctor-prescreve-header sticky top-0 z-50 border-b">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation("/")}
              className="text-white hover:bg-white/20"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="text-2xl font-bold">Atendimento</div>
          </div>
          {tempoRestante > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-white/20 px-3 py-2 text-white">
              <Clock className="h-4 w-4" />
              <span>{tempoRestante}m restantes</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Dados do Paciente */}
          <div className="lg:col-span-1">
            <Card className="doctor-prescreve-card">
              <h2 className="mb-4 text-xl font-bold">Dados do Paciente</h2>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Nome
                  </label>
                  <p className="text-sm font-medium">{atendimento.pacienteNome}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    CPF
                  </label>
                  <p className="text-sm font-medium">{atendimento.pacienteCpf}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Telefone
                  </label>
                  <p className="text-sm font-medium">
                    {atendimento.pacienteTelefone}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Email
                  </label>
                  <p className="text-sm font-medium">{atendimento.pacienteEmail}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Doenças Relatadas
                  </label>
                  <p className="text-sm font-medium">{atendimento.doencas}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Status
                  </label>
                  <Badge className="mt-1 doctor-prescreve-badge-em-atendimento">
                    {atendimento.status}
                  </Badge>
                </div>
              </div>
            </Card>
          </div>

          {/* Prontuário */}
          <div className="lg:col-span-2">
            <Card className="doctor-prescreve-card mb-6">
              <h2 className="mb-4 text-xl font-bold">Diagnóstico</h2>
              <Textarea
                placeholder="Descreva o diagnóstico do paciente"
                value={diagnostico}
                onChange={(e) => setDiagnostico(e.target.value)}
                className="min-h-24"
              />
            </Card>

            {/* Medicamentos */}
            <Card className="doctor-prescreve-card mb-6">
              <h2 className="mb-4 text-xl font-bold">Prescrição de Medicamentos</h2>

              {/* Novo Medicamento */}
              <div className="mb-6 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    placeholder="Nome do medicamento"
                    value={novoMedicamento.nome}
                    onChange={(e) =>
                      setNovoMedicamento({
                        ...novoMedicamento,
                        nome: e.target.value,
                      })
                    }
                  />
                  <Input
                    placeholder="Dosagem"
                    value={novoMedicamento.dosagem}
                    onChange={(e) =>
                      setNovoMedicamento({
                        ...novoMedicamento,
                        dosagem: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    placeholder="Duração (ex: 7 dias)"
                    value={novoMedicamento.duracao}
                    onChange={(e) =>
                      setNovoMedicamento({
                        ...novoMedicamento,
                        duracao: e.target.value,
                      })
                    }
                  />
                  <Input
                    type="number"
                    placeholder="Quantidade"
                    value={novoMedicamento.quantidade}
                    onChange={(e) =>
                      setNovoMedicamento({
                        ...novoMedicamento,
                        quantidade: parseInt(e.target.value) || 1,
                      })
                    }
                  />
                </div>
                <Input
                  placeholder="Instruções (opcional)"
                  value={novoMedicamento.instrucoes}
                  onChange={(e) =>
                    setNovoMedicamento({
                      ...novoMedicamento,
                      instrucoes: e.target.value,
                    })
                  }
                />
                <Button
                  onClick={handleAdicionarMedicamento}
                  className="w-full bg-primary hover:bg-primary/90"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Adicionar Medicamento
                </Button>
              </div>

              {/* Lista de Medicamentos */}
              {medicamentos.length > 0 && (
                <div className="space-y-2">
                  {medicamentos.map((med) => (
                    <div
                      key={med.id}
                      className="flex items-start justify-between rounded-lg border border-border p-3"
                    >
                      <div className="flex-1">
                        <p className="font-medium">{med.nome}</p>
                        <p className="text-xs text-muted-foreground">
                          {med.dosagem} • {med.duracao} • {med.quantidade} unidades
                        </p>
                        {med.instrucoes && (
                          <p className="text-xs text-muted-foreground">
                            Instruções: {med.instrucoes}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoverMedicamento(med.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Orientações */}
            <Card className="doctor-prescreve-card mb-6">
              <h2 className="mb-4 text-xl font-bold">Orientações Médicas</h2>
              <Textarea
                placeholder="Descreva as orientações para o paciente"
                value={orientacoes}
                onChange={(e) => setOrientacoes(e.target.value)}
                className="min-h-24"
              />
            </Card>

            {/* Ações */}
            <div className="flex gap-3 flex-wrap">
              <Button
                onClick={handleSalvarProntuario}
                variant="outline"
                className="flex-1 min-w-[120px]"
                disabled={salvarProntuarioMutation.isPending}
              >
                {salvarProntuarioMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Salvar Prontuário
              </Button>
              <Button
                onClick={handleAprovar}
                className="flex-1 min-w-[120px] bg-green-600 hover:bg-green-700"
                disabled={aprovarMutation.isPending || salvarProntuarioMutation.isPending}
              >
                {aprovarMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Aprovar & Emitir Receita
              </Button>
              <Button
                onClick={handleRecusar}
                variant="destructive"
                className="flex-1 min-w-[120px]"
                disabled={recusarMutation.isPending}
              >
                {recusarMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Recusar
              </Button>
              {prontuario?.receitaPdfUrl && (
                <Button
                  onClick={handleVisualizarReceita}
                  variant="outline"
                  className="flex-1 min-w-[120px] border-blue-500 text-blue-600 hover:bg-blue-50"
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Ver Receita
                </Button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
