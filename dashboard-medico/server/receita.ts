import PDFDocument from 'pdfkit';
import { Atendimento, Prontuario, Medicamento } from '../drizzle/schema';
import { decrypt } from './db';
import { storagePut } from './storage';

export async function gerarReceitaPDF(
  atendimento: Atendimento,
  prontuario: Prontuario | null,
  medicoNome: string
): Promise<{ url: string; key: string } | null> {
  try {
    // Descriptografar dados do paciente
    const pacienteNome = decrypt(atendimento.pacienteNomeEncrypted);
    const pacienteCpf = decrypt(atendimento.pacienteCpfEncrypted);
    const pacienteTelefone = decrypt(atendimento.pacienteTelefoneEncrypted);
    const doencas = decrypt(atendimento.doencasEncrypted);

    // Criar documento PDF
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    
    // Buffer para armazenar o PDF
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('RECEITA MÉDICA', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica').text('Doctor Prescreve - Telemedicina', { align: 'center' });
    doc.fontSize(10).text('Plataforma de Telemedicina Segura', { align: 'center' });
    doc.moveDown(1);

    // Data
    doc.fontSize(10).font('Helvetica').text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, { align: 'right' });
    doc.moveDown(1);

    // Dados do Paciente
    doc.fontSize(12).font('Helvetica-Bold').text('DADOS DO PACIENTE');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Nome: ${pacienteNome}`);
    doc.text(`CPF: ${pacienteCpf}`);
    doc.text(`Telefone: ${pacienteTelefone}`);
    doc.text(`Diagnóstico: ${doencas}`);
    doc.moveDown(1);

    // Diagnóstico
    if (prontuario?.diagnostico) {
      doc.fontSize(12).font('Helvetica-Bold').text('DIAGNÓSTICO');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(prontuario.diagnostico, { align: 'left' });
      doc.moveDown(0.5);
    }

    // Prescrição
    doc.fontSize(12).font('Helvetica-Bold').text('PRESCRIÇÃO');
    doc.moveDown(0.3);
    
    if (prontuario?.medicamentos && Array.isArray(prontuario.medicamentos)) {
      const medicamentos = prontuario.medicamentos as Medicamento[];
      medicamentos.forEach((med, index) => {
        doc.fontSize(10).font('Helvetica-Bold').text(`${index + 1}. ${med.nome}`);
        doc.fontSize(9).font('Helvetica');
        doc.text(`   Dosagem: ${med.dosagem}`);
        doc.text(`   Duração: ${med.duracao}`);
        doc.text(`   Quantidade: ${med.quantidade} unidades`);
        if (med.instrucoes) {
          doc.text(`   Instruções: ${med.instrucoes}`);
        }
        doc.moveDown(0.3);
      });
    } else {
      doc.fontSize(10).font('Helvetica').text('Nenhum medicamento prescrito');
    }
    doc.moveDown(1);

    // Orientações
    if (prontuario?.orientacoes) {
      doc.fontSize(12).font('Helvetica-Bold').text('ORIENTAÇÕES MÉDICAS');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(prontuario.orientacoes, { align: 'left' });
      doc.moveDown(1);
    }

    // Assinatura
    doc.moveTo(100, doc.y + 30).lineTo(300, doc.y + 30).stroke();
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(medicoNome, { align: 'left' });
    doc.text('Médico Responsável', { align: 'left' });

    // Rodapé
    doc.moveDown(2);
    doc.fontSize(8).font('Helvetica').text(
      'Este documento foi gerado digitalmente pela plataforma Doctor Prescreve e possui validade legal.',
      { align: 'center' }
    );
    doc.text(`ID da Receita: ${atendimento.id.substring(0, 8)}`, { align: 'center' });

    // Finalizar documento
    doc.end();

    // Aguardar conclusão
    return new Promise((resolve) => {
      doc.on('end', async () => {
        try {
          const pdfBuffer = Buffer.concat(chunks);
          const fileName = `receita_${atendimento.id}_${Date.now()}.pdf`;
          
          // Fazer upload para storage
          const { url, key } = await storagePut(
            `receitas/${fileName}`,
            pdfBuffer,
            'application/pdf'
          );

          resolve({ url, key });
        } catch (error) {
          console.error('Erro ao fazer upload do PDF:', error);
          resolve(null);
        }
      });
    });
  } catch (error) {
    console.error('Erro ao gerar receita PDF:', error);
    return null;
  }
}
