import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { setCredits, getBillingInfo } from "@/lib/billing";

// Gated to a single hardcoded account (lib/admin.ts) and only ever acts on
// that same account's own balance — there's no target-user parameter, by
// design, so this can never be used to adjust anyone else's credits.
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const { credits } = await req.json();
  if (typeof credits !== "number" || !Number.isFinite(credits)) {
    return NextResponse.json({ error: "credits must be a number" }, { status: 400 });
  }

  await setCredits(user.id, credits);
  const billing = await getBillingInfo(user.id);
  return NextResponse.json({ credits: billing?.credits ?? 0 });
}
