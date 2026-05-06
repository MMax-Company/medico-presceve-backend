import { DashboardLayout } from "@/components/DashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, Download, ExternalLink } from "lucide-react";

export default function Documentos() {
  const documentos = [
    {
      id: 1,
      titulo: "Termos de Uso da Plataforma",
      descricao: "Documento que regulamenta o uso geral da plataforma Doctor Prescreve, incluindo responsabilidades, limitações e políticas de cancelamento.",
      arquivo: "/docs/Termos_de_Uso.pdf",
      tipo: "Jurídico",
      versao: "1.0",
    },
    {
      id: 2,
      titulo: "Política de Privacidade e LGPD",
      descricao: "Termo de Consentimento LGPD para tratamento de dados sensíveis de saúde, conforme Lei Geral de Proteção de Dados (Lei nº 13.709/2018).",
      arquivo: "/docs/Politica_Privacidade_LGPD.pdf",
      tipo: "Jurídico",
      versao: "1.0",
    },
    {
      id: 3,
      titulo: "Projeto Piloto",
      descricao: "Documento de escopo, justificativa e fluxo operacional do projeto piloto Doctor Prescreve para renovação de receitas médicas.",
      arquivo: "/docs/Projeto_Piloto.pdf",
      tipo: "Operacional",
      versao: "1.0",
    },
  ];

  const handleDownload = (arquivo: string) => {
    const link = document.createElement("a");
    link.href = arquivo;
    link.download = arquivo.split("/").pop() || "documento.pdf";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <DashboardLayout>
      <main className="flex-1 overflow-auto">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Documentos e Termos
            </h1>
            <p className="text-gray-600">
              Acesse os documentos jurídicos e operacionais da plataforma Doctor Prescreve.
            </p>
          </div>

          {/* Grid de Documentos */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {documentos.map((doc) => (
              <Card
                key={doc.id}
                className="bg-white border-0 shadow-md hover:shadow-lg transition-shadow overflow-hidden"
              >
                <div className="p-6">
                  {/* Header do Card */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-100 to-blue-50 rounded-lg flex items-center justify-center">
                      <FileText className="w-6 h-6 text-blue-600" />
                    </div>
                    <span className="inline-block px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-700">
                      {doc.tipo}
                    </span>
                  </div>

                  {/* Conteúdo */}
                  <h3 className="text-lg font-bold text-gray-900 mb-2">
                    {doc.titulo}
                  </h3>
                  <p className="text-sm text-gray-600 mb-4 line-clamp-3">
                    {doc.descricao}
                  </p>

                  {/* Versão */}
                  <p className="text-xs text-gray-500 mb-4">
                    Versão: {doc.versao}
                  </p>

                  {/* Botões */}
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleDownload(doc.arquivo)}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                      size="sm"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      onClick={() => window.open(doc.arquivo, "_blank")}
                      variant="outline"
                      size="sm"
                      className="flex-1"
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      Visualizar
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Seção de Informações */}
          <Card className="mt-8 bg-gradient-to-r from-blue-50 to-blue-100 border-0 shadow-md">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                Informações Importantes
              </h2>
              <ul className="space-y-3 text-sm text-gray-700">
                <li className="flex items-start gap-3">
                  <span className="text-blue-600 font-bold">•</span>
                  <span>
                    Todos os documentos estão disponíveis em formato PDF e devem ser lidos
                    antes de utilizar a plataforma.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-blue-600 font-bold">•</span>
                  <span>
                    O aceite dos Termos de Uso e Política de Privacidade é obrigatório para
                    prosseguir com o atendimento.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-blue-600 font-bold">•</span>
                  <span>
                    Em caso de dúvidas, entre em contato com o suporte: (11) 8564-2069 ou
                    dr.max.vinicius.cg@outlook.com
                  </span>
                </li>
              </ul>
            </div>
          </Card>
        </div>
      </main>
    </DashboardLayout>
  );
}
