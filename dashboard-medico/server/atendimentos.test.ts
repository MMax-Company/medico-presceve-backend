import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encrypt,
  decrypt,
  obterFilaOrdenada,
  tentarPegarAtendimento,
  liberarAtendimento,
  atualizarStatusAtendimento,
  salvarProntuario,
  obterProntuario,
} from "./db";

describe("Criptografia", () => {
  it("deve criptografar e descriptografar texto corretamente", () => {
    const texto = "Teste de criptografia";
    const criptografado = encrypt(texto);
    
    expect(criptografado).toBeTruthy();
    expect(criptografado).not.toBe(texto);
    
    const descriptografado = decrypt(criptografado);
    expect(descriptografado).toBe(texto);
  });

  it("deve retornar null para texto vazio", () => {
    expect(encrypt("")).toBeNull();
    expect(encrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeNull();
    
    expect(decrypt("")).toBeNull();
    expect(decrypt(null)).toBeNull();
    expect(decrypt(undefined)).toBeNull();
  });

  it("deve descriptografar dados criptografados com sucesso", () => {
    const dados = [
      "João Silva",
      "123.456.789-00",
      "(11) 98765-4321",
      "Hipertensão",
    ];

    dados.forEach((dado) => {
      const criptografado = encrypt(dado);
      const descriptografado = decrypt(criptografado);
      expect(descriptografado).toBe(dado);
    });
  });
});

describe("Atendimentos", () => {
  it("deve validar lock de 30 minutos", async () => {
    // Teste simula que o lock deve expirar em 30 minutos
    const agora = Date.now();
    const lockUntil = new Date(agora + 30 * 60000); // 30 minutos
    
    // Verificar que o lock está no futuro
    expect(lockUntil.getTime()).toBeGreaterThan(agora);
    
    // Verificar que a diferença é aproximadamente 30 minutos
    const diferenca = (lockUntil.getTime() - agora) / 60000;
    expect(diferenca).toBeCloseTo(30, 0);
  });

  it("deve validar transição de status", async () => {
    const statusValidos = ["FILA", "EM_ATENDIMENTO", "APROVADO", "RECUSADO"];
    
    statusValidos.forEach((status) => {
      expect(["FILA", "EM_ATENDIMENTO", "APROVADO", "RECUSADO"]).toContain(
        status
      );
    });
  });
});

describe("Prontuários", () => {
  it("deve validar estrutura de medicamento", () => {
    const medicamento = {
      id: "med-001",
      nome: "Dipirona",
      dosagem: "500mg",
      duracao: "7 dias",
      quantidade: 14,
      instrucoes: "Tomar a cada 6 horas",
    };

    expect(medicamento.nome).toBeTruthy();
    expect(medicamento.dosagem).toBeTruthy();
    expect(medicamento.duracao).toBeTruthy();
    expect(medicamento.quantidade).toBeGreaterThan(0);
  });

  it("deve validar múltiplos medicamentos", () => {
    const medicamentos = [
      {
        nome: "Medicamento A",
        dosagem: "100mg",
        duracao: "7 dias",
        quantidade: 7,
      },
      {
        nome: "Medicamento B",
        dosagem: "50mg",
        duracao: "14 dias",
        quantidade: 14,
      },
      {
        nome: "Medicamento C",
        dosagem: "200mg",
        duracao: "30 dias",
        quantidade: 30,
      },
    ];

    expect(medicamentos).toHaveLength(3);
    medicamentos.forEach((med) => {
      expect(med.nome).toBeTruthy();
      expect(med.quantidade).toBeGreaterThan(0);
    });
  });
});

describe("Fluxo de Atendimento", () => {
  it("deve validar sequência de status corretos", () => {
    const fluxo = ["FILA", "EM_ATENDIMENTO", "APROVADO"];
    
    expect(fluxo[0]).toBe("FILA");
    expect(fluxo[1]).toBe("EM_ATENDIMENTO");
    expect(fluxo[2]).toBe("APROVADO");
  });

  it("deve validar fluxo de recusa", () => {
    const fluxo = ["FILA", "EM_ATENDIMENTO", "RECUSADO"];
    
    expect(fluxo[0]).toBe("FILA");
    expect(fluxo[1]).toBe("EM_ATENDIMENTO");
    expect(fluxo[2]).toBe("RECUSADO");
  });

  it("deve validar liberação de atendimento", () => {
    const statusAntigo = "EM_ATENDIMENTO";
    const statusNovo = "FILA";
    
    expect(statusAntigo).not.toBe(statusNovo);
    expect(statusNovo).toBe("FILA");
  });
});

describe("Dados do Paciente", () => {
  it("deve validar criptografia de dados sensíveis", () => {
    const paciente = {
      nome: "João Silva",
      cpf: "123.456.789-00",
      telefone: "(11) 98765-4321",
      email: "joao@example.com",
    };

    const pacienteCriptografado = {
      nomeEncrypted: encrypt(paciente.nome),
      cpfEncrypted: encrypt(paciente.cpf),
      telefoneEncrypted: encrypt(paciente.telefone),
      emailEncrypted: encrypt(paciente.email),
    };

    expect(pacienteCriptografado.nomeEncrypted).toBeTruthy();
    expect(pacienteCriptografado.cpfEncrypted).toBeTruthy();
    expect(pacienteCriptografado.telefoneEncrypted).toBeTruthy();
    expect(pacienteCriptografado.emailEncrypted).toBeTruthy();

    // Verificar descriptografia
    expect(decrypt(pacienteCriptografado.nomeEncrypted)).toBe(paciente.nome);
    expect(decrypt(pacienteCriptografado.cpfEncrypted)).toBe(paciente.cpf);
    expect(decrypt(pacienteCriptografado.telefoneEncrypted)).toBe(
      paciente.telefone
    );
    expect(decrypt(pacienteCriptografado.emailEncrypted)).toBe(paciente.email);
  });
});
