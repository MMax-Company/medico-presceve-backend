import { integer, pgEnum, pgTable, text, timestamp, varchar, jsonb, boolean, decimal, serial } from "drizzle-orm/pg-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const roleEnum = pgEnum("role", ["user", "admin", "medico"]);
export const statusEnum = pgEnum("status", ["FILA", "EM_ATENDIMENTO", "APROVADO", "RECUSADO"]);

export const users = pgTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: serial("id").primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  crm: varchar("crm", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Tabela de atendimentos
export const atendimentos = pgTable("atendimentos", {
  id: varchar("id", { length: 64 }).primaryKey(),
  pacienteNomeEncrypted: text("pacienteNomeEncrypted"),
  pacienteCpfEncrypted: text("pacienteCpfEncrypted"),
  pacienteTelefoneEncrypted: text("pacienteTelefoneEncrypted"),
  pacienteEmailEncrypted: text("pacienteEmailEncrypted"),
  pacienteNascimentoEncrypted: text("pacienteNascimentoEncrypted"),
  doencasEncrypted: text("doencasEncrypted"),
  status: statusEnum("status").default("FILA").notNull(),
  pagamento: boolean("pagamento").default(false).notNull(),
  pagamentoEm: timestamp("pagamentoEm"),
  emAtendimentoPor: varchar("emAtendimentoPor", { length: 64 }),
  emAtendimentoDesde: timestamp("emAtendimentoDesde"),
  lockedUntil: timestamp("lockedUntil"),
  tentativasLock: integer("tentativasLock").default(0),
  finalizadoEm: timestamp("finalizadoEm"),
  criadoEm: timestamp("criadoEm").defaultNow().notNull(),
  atualizadoEm: timestamp("atualizadoEm").defaultNow().notNull(),
});

export type Atendimento = typeof atendimentos.$inferSelect;
export type InsertAtendimento = typeof atendimentos.$inferInsert;

// Tabela de prontuários
export const prontuarios = pgTable("prontuarios", {
  id: serial("id").primaryKey(),
  atendimentoId: varchar("atendimentoId", { length: 64 }).notNull(),
  medicamentos: jsonb("medicamentos"),
  orientacoes: text("orientacoes"),
  diagnostico: text("diagnostico"),
  observacoes: text("observacoes"),
  receitaPdfUrl: varchar("receitaPdfUrl", { length: 500 }),
  criadoEm: timestamp("criadoEm").defaultNow().notNull(),
  atualizadoEm: timestamp("atualizadoEm").defaultNow().notNull(),
});

export type Prontuario = typeof prontuarios.$inferSelect;
export type InsertProntuario = typeof prontuarios.$inferInsert;

// Tipo para medicamentos no prontuário
export interface Medicamento {
  id?: string;
  nome: string;
  dosagem: string;
  duracao: string;
  quantidade: number;
  instrucoes?: string;
}
