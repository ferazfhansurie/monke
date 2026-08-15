import { NextRequest, NextResponse } from "next/server";
import { createUser, createSession } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { name, email, password } = await req.json();
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const result = await createUser(name, email, password);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const session = await createSession(result.id);
    const res = NextResponse.json({ user: { id: result.id, name: result.name, email: result.email } });
    res.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signup failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
