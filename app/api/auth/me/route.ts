import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ user: null });
  return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } });
}
