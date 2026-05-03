import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Activity,
  Clock,
  CheckCircle,
  AlertCircle,
  FileText,
  LogOut,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { useState } from "react";

export default function Home() {
  const { user, isAuthenticated, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logoutMutation = trpc.auth.logout.useMutation();

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutMutation.mutateAsync();
      logout();
      setLocation("/");
    } catch (error) {
      console.error("Erro ao fazer logout:", error);
      setIsLoggingOut(false);
    }
  };

  // Queries
  const filaQuery = trpc.atendimentos.obterFila.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const estatisticasQuery = trpc.atendimentos.obterEstatisticas.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  const tempoMedioQuery = trpc.atendimentos.obterTempoMedioEspera.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1e3a8a] to-[#3b82f6] flex items-center justify-center">
        <div className="text-center text-white">
          <h1 className="text-4xl font-bold mb-4">Doctor Prescreve</h1>
          <p className="text-xl mb-8">Painel Médico</p>
          <Button size="lg" variant="secondary">
            Fazer Login
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header com identidade Doctor Prescreve */}
      <header className="bg-gradient-to-r from-[#1e3a8a] to-[#2563eb] text-white shadow-lg">
        <div className="container mx-auto px-4 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center">
              <span className="text-[#1e3a8a] font-bold text-lg">Rx</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">Doctor Prescreve</h1>
              <p className="text-sm text-blue-100">Painel Médico</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm">Bem-vindo, {user?.name || "Médico"}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="text-white hover:bg-white/20"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sair
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Título da seção */}
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-2">Dashboard</h2>
          <p className="text-gray-600">
            Gerenciamento de atendimentos em tempo real
          </p>
        </div>

        {/* Grid de Métricas */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {/* Card 1: Total de Atendimentos */}
          <Card className="bg-white border-0 shadow-md hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-100 to-blue-50 rounded-lg flex items-center justify-center">
                  <Users className="w-6 h-6 text-[#1e3a8a]" />
                </div>
                <span className="text-xs font-semibold text-gray-500 uppercase">
                  Total
                </span>
              </div>
              <div className="mb-2">
                <p className="text-3xl font-bold text-[#1e3a8a]">
                  {estatisticasQuery.data?.totalAtendimentos || 0}
                </p>
              </div>
              <p className="text-sm text-gray-600">Total de Atendimentos</p>
            </div>
          </Card>

          {/* Card 2: Fila Atual */}
          <Card className="bg-white border-0 shadow-md hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-orange-100 to-orange-50 rounded-lg flex items-center justify-center">
                  <Activity className="w-6 h-6 text-orange-600" />
                </div>
                <span className="text-xs font-semibold text-gray-500 uppercase">
                  Fila
                </span>
              </div>
              <div className="mb-2">
                <p className="text-3xl font-bold text-orange-600">
                  {filaQuery.data?.length || 0}
                </p>
              </div>
              <p className="text-sm text-gray-600">Fila Atual</p>
            </div>
          </Card>

          {/* Card 3: Tempo Médio */}
          <Card className="bg-white border-0 shadow-md hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-purple-100 to-purple-50 rounded-lg flex items-center justify-center">
                  <Clock className="w-6 h-6 text-purple-600" />
                </div>
                <span className="text-xs font-semibold text-gray-500 uppercase">
                  Tempo
                </span>
              </div>
              <div className="mb-2">
                <p className="text-3xl font-bold text-purple-600">
                  {tempoMedioQuery.data || 0}
                </p>
                <p className="text-xs text-gray-500">minutos</p>
              </div>
              <p className="text-sm text-gray-600">Tempo Médio de Espera</p>
            </div>
          </Card>

          {/* Card 4: Receitas Emitidas */}
          <Card className="bg-white border-0 shadow-md hover:shadow-lg transition-shadow">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-green-100 to-green-50 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-6 h-6 text-green-600" />
                </div>
                <span className="text-xs font-semibold text-gray-500 uppercase">
                  Receitas
                </span>
              </div>
              <div className="mb-2">
                <p className="text-3xl font-bold text-green-600">
                  {estatisticasQuery.data?.receitasEmitidas || 0}
                </p>
              </div>
              <p className="text-sm text-gray-600">Receitas Emitidas</p>
            </div>
          </Card>
        </div>

        {/* Seção de Status e Ações */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Status dos Atendimentos */}
          <Card className="lg:col-span-2 bg-white border-0 shadow-md">
            <div className="p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-6">
                Status dos Atendimentos
              </h3>

              <div className="space-y-4">
                {/* Em Atendimento */}
                <div className="flex items-center justify-between p-4 bg-gradient-to-r from-blue-50 to-transparent rounded-lg border border-blue-100">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-[#1e3a8a] rounded-full"></div>
                    <span className="font-medium text-gray-900">
                      Em Atendimento
                    </span>
                  </div>
                  <Badge className="bg-[#1e3a8a] text-white">
                    {estatisticasQuery.data?.emAtendimento || 0}
                  </Badge>
                </div>

                {/* Aprovados */}
                <div className="flex items-center justify-between p-4 bg-gradient-to-r from-green-50 to-transparent rounded-lg border border-green-100">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-green-600 rounded-full"></div>
                    <span className="font-medium text-gray-900">Aprovados</span>
                  </div>
                  <Badge className="bg-green-600 text-white">
                    {estatisticasQuery.data?.aprovados || 0}
                  </Badge>
                </div>

                {/* Recusados */}
                <div className="flex items-center justify-between p-4 bg-gradient-to-r from-red-50 to-transparent rounded-lg border border-red-100">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-red-600 rounded-full"></div>
                    <span className="font-medium text-gray-900">Recusados</span>
                  </div>
                  <Badge className="bg-red-600 text-white">
                    {estatisticasQuery.data?.recusados || 0}
                  </Badge>
                </div>
              </div>
            </div>
          </Card>

          {/* Ações Rápidas */}
          <Card className="bg-white border-0 shadow-md">
            <div className="p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-6">
                Ações Rápidas
              </h3>

              <div className="space-y-3">
                <Button
                  onClick={() => setLocation("/atendimento/novo")}
                  className="w-full bg-gradient-to-r from-[#1e3a8a] to-[#2563eb] hover:from-[#1e3a8a] hover:to-[#1e40af] text-white font-semibold"
                >
                  <Users className="w-4 h-4 mr-2" />
                  Pegar Próximo Atendimento
                </Button>

                <Button
                  variant="outline"
                  onClick={() => setLocation("/historico")}
                  className="w-full border-[#1e3a8a] text-[#1e3a8a] hover:bg-blue-50"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Ver Fila Completa
                </Button>

                <Button
                  variant="outline"
                  onClick={() => setLocation("/historico")}
                  className="w-full border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Histórico de Atendimentos
                </Button>
              </div>
            </div>
          </Card>
        </div>

        {/* Informações da Marca */}
        <div className="mt-12 p-6 bg-gradient-to-r from-[#1e3a8a] to-[#2563eb] text-white rounded-lg text-center">
          <p className="text-sm opacity-90">
            Doctor Prescreve © 2026 | Painel Médico Profissional
          </p>
        </div>
      </main>
    </div>
  );
}
