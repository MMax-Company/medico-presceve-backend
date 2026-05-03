import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, Search, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import { toast } from "sonner";

export default function Historico() {
  const { user, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const [filtroStatus, setFiltroStatus] = useState<string>("TODOS");
  const [buscaTexto, setBuscaTexto] = useState("");
  const [filtroData, setFiltroData] = useState<string>("");

  // Query para obter histórico
  const historicoQuery = trpc.atendimentos.obterHistorico.useQuery(undefined, {
    enabled: isAuthenticated && user?.role === 'medico',
  });

  // Filtrar dados
  const historicoFiltrado = useMemo(() => {
    if (!historicoQuery.data) return [];

    return historicoQuery.data.filter((at: any) => {
      // Filtro por status
      if (filtroStatus !== "TODOS" && at.status !== filtroStatus) {
        return false;
      }

      // Filtro por texto (nome ou CPF)
      if (buscaTexto) {
        const busca = buscaTexto.toLowerCase();
        const nome = at.pacienteNome?.toLowerCase() || "";
        const cpf = at.pacienteCpf?.toLowerCase() || "";
        if (!nome.includes(busca) && !cpf.includes(busca)) {
          return false;
        }
      }

      // Filtro por data
      if (filtroData) {
        const dataAtendimento = new Date(at.finalizadoEm).toISOString().split("T")[0];
        if (dataAtendimento !== filtroData) {
          return false;
        }
      }

      return true;
    });
  }, [historicoQuery.data, filtroStatus, buscaTexto, filtroData]);

  const handleDownloadReceita = async (atendimentoId: string) => {
    try {
      const resultado = await (trpc.decisoes.obterReceita.useQuery as any)(atendimentoId);
      if (resultado?.data?.url) {
        window.open(resultado.data.url, "_blank");
      }
    } catch (error) {
      toast.error("Erro ao baixar receita");
    }
  };

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
            <div className="text-2xl font-bold">Histórico de Atendimentos</div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-8">
        {/* Filtros */}
        <Card className="doctor-prescreve-card mb-6">
          <h2 className="mb-4 text-lg font-bold">Filtros</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {/* Busca por nome/CPF */}
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou CPF"
                value={buscaTexto}
                onChange={(e) => setBuscaTexto(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Filtro por status */}
            <select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="TODOS">Todos os Status</option>
              <option value="APROVADO">Aprovados</option>
              <option value="RECUSADO">Recusados</option>
            </select>

            {/* Filtro por data */}
            <Input
              type="date"
              value={filtroData}
              onChange={(e) => setFiltroData(e.target.value)}
            />

            {/* Botão limpar filtros */}
            <Button
              variant="outline"
              onClick={() => {
                setBuscaTexto("");
                setFiltroStatus("TODOS");
                setFiltroData("");
              }}
            >
              Limpar Filtros
            </Button>
          </div>
        </Card>

        {/* Tabela de Histórico */}
        <Card className="doctor-prescreve-card">
          {historicoQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : historicoFiltrado.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              Nenhum atendimento encontrado
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      Paciente
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      CPF
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      Data
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      Tempo de Espera
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">
                      Ações
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {historicoFiltrado.map((at: any) => (
                    <tr key={at.id} className="border-b border-border hover:bg-muted/50">
                      <td className="px-4 py-3 text-sm">{at.pacienteNome}</td>
                      <td className="px-4 py-3 text-sm">{at.pacienteCpf}</td>
                      <td className="px-4 py-3">
                        {at.status === "APROVADO" ? (
                          <Badge className="doctor-prescreve-badge-aprovado">
                            APROVADO
                          </Badge>
                        ) : (
                          <Badge className="doctor-prescreve-badge-recusado">
                            RECUSADO
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {new Date(at.finalizadoEm).toLocaleDateString("pt-BR")}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {at.tempoEspera ? `${at.tempoEspera}m` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        {at.status === "APROVADO" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDownloadReceita(at.id)}
                            className="gap-2"
                          >
                            <Download className="h-4 w-4" />
                            Receita
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Resumo */}
          {historicoFiltrado.length > 0 && (
            <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
              Total: {historicoFiltrado.length} atendimento(s) •
              Aprovados: {historicoFiltrado.filter((a: any) => a.status === "APROVADO").length} •
              Recusados: {historicoFiltrado.filter((a: any) => a.status === "RECUSADO").length}
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
