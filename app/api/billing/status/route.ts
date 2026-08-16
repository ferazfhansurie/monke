import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getBillingInfo } from "@/lib/billing";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const billing = await getBillingInfo(user.id);
  return NextResponse.json({
    plan: billing?.plan ?? null,
    credits: billing?.credits ?? 0,
    subscriptionActive: billing?.subscriptionActive ?? false,
    subscriptionExpiresAt: billing?.subscriptionExpiresAt ?? null,
  });
}
