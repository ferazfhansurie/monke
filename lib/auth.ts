import type { NextRequest } from "next/server";
import { getUserFromToken, type User } from "./db";

export const SESSION_COOKIE = "monke_session";

export async function requireUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await getUserFromToken(token);
  return user ?? null;
}
