import type { NextRequest } from "next/server";
import { getUserFromToken, type User } from "./db";
import { ensureAdminGrant } from "./billing";

export const SESSION_COOKIE = "monke_session";

export async function requireUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await getUserFromToken(token);
  if (!user) return null;
  // Self-healing: works whether this account signed up before or after the
  // admin grant existed, and is a no-op once already active — see
  // ensureAdminGrant's own idempotency guard.
  await ensureAdminGrant(user.id, user.email);
  return user;
}
