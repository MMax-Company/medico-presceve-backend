import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, atendimentos, prontuarios, Atendimento, InsertAtendimento, Prontuario, InsertProntuario } from "../drizzle/schema";
import { ENV } from './_core/env';
import crypto from 'crypto';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// Funções de criptografia
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';
let key: Buffer;

if (/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) {
  key = Buffer.from(ENCRYPTION_KEY, 'hex');
} else {
  key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

export function encrypt(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  } catch (e) {
    return null;
  }
}

export function decrypt(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const [ivHex, data] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
  } catch (e) {
    return null;
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Funções para Atendimentos
export async function criarAtendimento(dados: InsertAtendimento): Promise<Atendimento | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const atendimento: InsertAtendimento = {
      ...dados,
      id: dados.id || crypto.randomUUID(),
      status: 'FILA',
      pagamento: false,
    };
    await db.insert(atendimentos).values(atendimento);
    return db.select().from(atendimentos).where(eq(atendimentos.id, atendimento.id)).then(r => r[0] || null);
  } catch (error) {
    console.error("[Database] Failed to create atendimento:", error);
    return null;
  }
}

export async function obterAtendimento(id: string): Promise<Atendimento | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(atendimentos).where(eq(atendimentos.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function obterFilaOrdenada(): Promise<Atendimento[]> {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select()
    .from(atendimentos)
    .where(
      and(
        eq(atendimentos.pagamento, true),
        eq(atendimentos.status, 'FILA')
      )
    )
    .orderBy(desc(atendimentos.criadoEm));

  return result;
}

export async function tentarPegarAtendimento(atendimentoId: string, medicoId: string): Promise<{ sucesso: boolean; atendimento?: Atendimento; motivo?: string }> {
  const db = await getDb();
  if (!db) return { sucesso: false, motivo: 'Database not available' };

  const at = await obterAtendimento(atendimentoId);
  if (!at) return { sucesso: false, motivo: 'Atendimento não encontrado' };

  if (at.status === 'EM_ATENDIMENTO' && at.lockedUntil && new Date(at.lockedUntil) > new Date()) {
    return { sucesso: false, motivo: 'Já em atendimento por outro médico' };
  }

  const lockUntil = new Date(Date.now() + 30 * 60000); // 30 minutos
  
  await db.update(atendimentos)
    .set({
      status: 'EM_ATENDIMENTO',
      emAtendimentoPor: medicoId,
      emAtendimentoDesde: new Date(),
      lockedUntil: lockUntil,
      tentativasLock: (at.tentativasLock || 0) + 1,
    })
    .where(eq(atendimentos.id, atendimentoId));

  const updated = await obterAtendimento(atendimentoId);
  return { sucesso: true, atendimento: updated || undefined };
}

export async function liberarAtendimento(atendimentoId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  await db.update(atendimentos)
    .set({
      status: 'FILA',
      emAtendimentoPor: null,
      emAtendimentoDesde: null,
      lockedUntil: null,
    })
    .where(eq(atendimentos.id, atendimentoId));

  return true;
}

export async function atualizarStatusAtendimento(atendimentoId: string, novoStatus: 'FILA' | 'EM_ATENDIMENTO' | 'APROVADO' | 'RECUSADO'): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  await db.update(atendimentos)
    .set({
      status: novoStatus,
      finalizadoEm: novoStatus === 'APROVADO' || novoStatus === 'RECUSADO' ? new Date() : null,
    })
    .where(eq(atendimentos.id, atendimentoId));

  return true;
}

// Funções para Prontuários
export async function salvarProntuario(atendimentoId: string, dados: Omit<InsertProntuario, 'atendimentoId'>): Promise<Prontuario | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const existing = await db.select().from(prontuarios).where(eq(prontuarios.atendimentoId, atendimentoId)).limit(1);
    
    if (existing.length > 0) {
      await db.update(prontuarios)
        .set(dados)
        .where(eq(prontuarios.atendimentoId, atendimentoId));
      return db.select().from(prontuarios).where(eq(prontuarios.atendimentoId, atendimentoId)).then(r => r[0] || null);
    } else {
      await db.insert(prontuarios).values({ ...dados, atendimentoId });
      return db.select().from(prontuarios).where(eq(prontuarios.atendimentoId, atendimentoId)).then(r => r[0] || null);
    }
  } catch (error) {
    console.error("[Database] Failed to save prontuario:", error);
    return null;
  }
}

export async function obterProntuario(atendimentoId: string): Promise<Prontuario | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(prontuarios).where(eq(prontuarios.atendimentoId, atendimentoId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function obterEstatisticas() {
  const db = await getDb();
  if (!db) return { total: 0, fila: 0, emAtendimento: 0, aprovados: 0, recusados: 0 };

  const todos = await db.select().from(atendimentos);
  const fila = await db.select().from(atendimentos).where(and(eq(atendimentos.pagamento, true), eq(atendimentos.status, 'FILA')));
  const emAtendimento = await db.select().from(atendimentos).where(eq(atendimentos.status, 'EM_ATENDIMENTO'));
  const aprovados = await db.select().from(atendimentos).where(eq(atendimentos.status, 'APROVADO'));
  const recusados = await db.select().from(atendimentos).where(eq(atendimentos.status, 'RECUSADO'));

  return {
    total: todos.length,
    fila: fila.length,
    emAtendimento: emAtendimento.length,
    aprovados: aprovados.length,
    recusados: recusados.length,
  };
}
