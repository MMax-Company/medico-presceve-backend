import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Users, Clock, CheckCircle, XCircle, Activity } from "lucide-react";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  // Queries tRPC
  const estatisticasQuery = trpc.atendimentos.obterEstatisticas.useQuery(undefined, {
    enabled: isAuthenticated && user?.role === 'medico',
    refetchInterval: 10000, // Atualizar a cada 10 segundos
  });

  const filaQuery = trpc.atendimentos.obterFila.useQuery(undefined, {
    enabled: isAuthenticated && user?.role === 'medico',
    refetchInterval: 10000,
  });

  const tempoMedioQuery = trpc.atendimentos.obterTempoMedioEspera.useQuery(undefined, {
    enabled: isAuthenticated && user?.role === 'medico',
    refetchInterval: 10000,
  });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <div className="text-center">
          <h1 className="mb-4 text-4xl font-bold text-primary">Doctor Prescreve</h1>
          <p className="mb-8 text-lg text-muted-foreground">Painel Médico</p>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            className="bg-primary hover:bg-primary/90"
            size="lg"
          >
            Fazer Login
          </Button>
        </div>
      </div>
    );
  }

  // Verificar se é médico
  if (user?.role !== 'medico' && user?.role !== 'admin') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="mb-4 text-2xl font-bold">Acesso Restrito</h1>
          <p className="text-muted-foreground">Apenas médicos podem acessar este painel.</p>
          <Button onClick={logout} className="mt-4">
            Fazer Logout
          </Button>
        </div>
      </div>
    );
  }

  const stats = estatisticasQuery.data;
  const fila = filaQuery.data || [];
  const tempoMedio = tempoMedioQuery.data || 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="doctor-prescreve-header sticky top-0 z-50 border-b">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="text-2xl font-bold">Doctor Prescreve</div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm">Bem-vindo, {user?.name}</span>
            <Button variant="outline" size="sm" onClick={logout}>
              Sair
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-8">
        {/* Dashboard Title */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground">Gerenciamento de atendimentos em tempo real</p>
        </div>

        {/* Metrics Grid */}
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Total de Atendimentos */}
          <Card className="doctor-prescreve-card">
            <div className="doctor-prescreve-metric">
              <Users className="mb-2 h-8 w-8 text-primary" />
              <div className="doctor-prescreve-metric-value">
                {stats?.total || 0}
              </div>
              <div className="doctor-prescreve-metric-label">Total de Atendimentos</div>
            </div>
          </Card>

          {/* Fila Atual */}
          <Card className="doctor-prescreve-card">
            <div className="doctor-prescreve-metric">
              <Activity className="mb-2 h-8 w-8 text-primary" />
              <div className="doctor-prescreve-metric-value">
                {stats?.fila || 0}
              </div>
              <div className="doctor-prescreve-metric-label">Fila Atual</div>
            </div>
          </Card>

          {/* Tempo Médio de Espera */}
          <Card className="doctor-prescreve-card">
            <div className="doctor-prescreve-metric">
              <Clock className="mb-2 h-8 w-8 text-primary" />
              <div className="doctor-prescreve-metric-value">
                {tempoMedio}m
              </div>
              <div className="doctor-prescreve-metric-label">Tempo Médio</div>
            </div>
          </Card>

          {/* Receitas Emitidas */}
          <Card className="doctor-prescreve-card">
            <div className="doctor-prescreve-metric">
              <CheckCircle className="mb-2 h-8 w-8 text-primary" />
              <div className="doctor-prescreve-metric-value">
                {stats?.aprovados || 0}
              </div>
              <div className="doctor-prescreve-metric-label">Receitas Emitidas</div>
            </div>
          </Card>
        </div>

        {/* Status Overview */}
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Status Distribution */}
          <Card className="doctor-prescreve-card">
            <h2 className="mb-4 text-xl font-bold">Status dos Atendimentos</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Em Atendimento</span>
                <Badge className="doctor-prescreve-badge-em-atendimento">
                  {stats?.emAtendimento || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Aprovados</span>
                <Badge className="doctor-prescreve-badge-aprovado">
                  {stats?.aprovados || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Recusados</span>
                <Badge className="doctor-prescreve-badge-recusado">
                  {stats?.recusados || 0}
                </Badge>
              </div>
            </div>
          </Card>

          {/* Quick Actions */}
          <Card className="doctor-prescreve-card">
            <h2 className="mb-4 text-xl font-bold">Ações Rápidas</h2>
            <div className="space-y-2">
              <Button className="w-full bg-primary hover:bg-primary/90">
                Pegar Próximo Atendimento
              </Button>
              <Button variant="outline" className="w-full">
                Ver Fila Completa
              </Button>
              <Button variant="outline" className="w-full">
                Histórico de Atendimentos
              </Button>
            </div>
          </Card>
        </div>

        {/* Fila Preview */}
        <Card className="doctor-prescreve-card">
          <h2 className="mb-4 text-xl font-bold">Próximos na Fila</h2>
          {fila.length === 0 ? (
            <p className="text-center text-muted-foreground">Nenhum atendimento na fila</p>
          ) : (
            <div className="space-y-2">
              {fila.slice(0, 5).map((atendimento, index) => (
                <div
                  key={atendimento.id}
                  className="flex items-center justify-between rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {index + 1}
                    </span>
                    <div>
                      <p className="font-medium">{atendimento.pacienteNome}</p>
                      <p className="text-xs text-muted-foreground">
                        {atendimento.doencas}
                      </p>
                    </div>
                  </div>
                  <Badge className="doctor-prescreve-badge-fila">FILA</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
