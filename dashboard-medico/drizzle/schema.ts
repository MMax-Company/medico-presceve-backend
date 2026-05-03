import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, boolean, decimal } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "medico"]).default("user").notNull(),
  crm: varchar("crm", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Tabela de atendimentos
export const atendimentos = mysqlTable("atendimentos", {
  id: varchar("id", { length: 64 }).primaryKey(),
  pacienteNomeEncrypted: text("pacienteNomeEncrypted"),
  pacienteCpfEncrypted: text("pacienteCpfEncrypted"),
  pacienteTelefoneEncrypted: text("pacienteTelefoneEncrypted"),
  pacienteEmailEncrypted: text("pacienteEmailEncrypted"),
  pacienteNascimentoEncrypted: text("pacienteNascimentoEncrypted"),
  doencasEncrypted: text("doencasEncrypted"),
  status: mysqlEnum("status", ["FILA", "EM_ATENDIMENTO", "APROVADO", "RECUSADO"]).default("FILA").notNull(),
  pagamento: boolean("pagamento").default(false).notNull(),
  pagamentoEm: timestamp("pagamentoEm"),
  emAtendimentoPor: varchar("emAtendimentoPor", { length: 64 }),
  emAtendimentoDesde: timestamp("emAtendimentoDesde"),
  lockedUntil: timestamp("lockedUntil"),
  tentativasLock: int("tentativasLock").default(0),
  finalizadoEm: timestamp("finalizadoEm"),
  criadoEm: timestamp("criadoEm").defaultNow().notNull(),
  atualizadoEm: timestamp("atualizadoEm").defaultNow().onUpdateNow().notNull(),
});

export type Atendimento = typeof atendimentos.$inferSelect;
export type InsertAtendimento = typeof atendimentos.$inferInsert;

// Tabela de prontuários
export const prontuarios = mysqlTable("prontuarios", {
  id: int("id").autoincrement().primaryKey(),
  atendimentoId: varchar("atendimentoId", { length: 64 }).notNull(),
  medicamentos: json("medicamentos"),
  orientacoes: text("orientacoes"),
  diagnostico: text("diagnostico"),
  observacoes: text("observacoes"),
  receitaPdfUrl: varchar("receitaPdfUrl", { length: 500 }),
  criadoEm: timestamp("criadoEm").defaultNow().notNull(),
  atualizadoEm: timestamp("atualizadoEm").defaultNow().onUpdateNow().notNull(),
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