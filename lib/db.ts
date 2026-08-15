import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "crypto";

type SqlRow = Record<string, unknown>;
type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRow[]>;

const sql: SqlFn = (strings, ...values) => {
  const fn = neon(process.env.DATABASE_URL!);
  return fn(strings, ...values) as Promise<SqlRow[]>;
};

// --- Users ---

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

function rowToUser(row: SqlRow): User {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// Same hashing scheme as MotionBoards (SHA-256) — consistent across the
// two products rather than introducing a second scheme with its own review.
function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

let tablesEnsured = false;
async function ensureTables() {
  if (tablesEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS monke_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS monke_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES monke_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  tablesEnsured = true;
}

export async function createUser(name: string, email: string, password: string): Promise<User | { error: string }> {
  await ensureTables();
  if (!name.trim()) return { error: "Name is required" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email" };
  if (password.length < 8) return { error: "Password must be at least 8 characters" };

  const existing = await sql`SELECT id FROM monke_users WHERE LOWER(email) = LOWER(${email})`;
  if (existing.length > 0) return { error: "An account with this email already exists" };

  const id = `user_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const hash = hashPassword(password);
  const rows = await sql`
    INSERT INTO monke_users (id, name, email, password_hash)
    VALUES (${id}, ${name.trim()}, ${email.toLowerCase()}, ${hash})
    RETURNING *
  `;
  return rowToUser(rows[0]);
}

export async function authenticateUser(email: string, password: string): Promise<User | null> {
  await ensureTables();
  const rows = await sql`SELECT * FROM monke_users WHERE LOWER(email) = LOWER(${email})`;
  if (rows.length === 0) return null;
  const user = rowToUser(rows[0]);
  if (user.passwordHash !== hashPassword(password)) return null;
  return user;
}

export async function getUserById(id: string): Promise<User | undefined> {
  await ensureTables();
  const rows = await sql`SELECT * FROM monke_users WHERE id = ${id}`;
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

// --- Sessions ---

export interface Session {
  token: string;
  userId: string;
  expiresAt: string;
}

export async function createSession(userId: string): Promise<Session> {
  await ensureTables();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  await sql`
    INSERT INTO monke_sessions (token, user_id, expires_at)
    VALUES (${token}, ${userId}, ${expiresAt.toISOString()})
  `;
  return { token, userId, expiresAt: expiresAt.toISOString() };
}

export async function getUserFromToken(token: string): Promise<User | undefined> {
  await ensureTables();
  const rows = await sql`
    SELECT u.* FROM monke_sessions s
    JOIN monke_users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

export async function deleteSession(token: string): Promise<void> {
  await ensureTables();
  await sql`DELETE FROM monke_sessions WHERE token = ${token}`;
}
