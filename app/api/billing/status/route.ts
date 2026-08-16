import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getBillingInfo } from "@/lib/billing";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const billing = await getBillingInfo(user.id);
    return NextResponse.json({
      plan: billing?.plan ?? null,
      credits: billing?.credits ?? 0,
      subscriptionActive: billing?.subscriptionActive ?? false,
      subscriptionExpiresAt: billing?.subscriptionExpiresAt ?? null,
    });
  } catch (err) {
    // This route gates app/page.tsx's redirect logic — an uncaught
    // exception here previously produced an HTML error page, which the
    // client's res.json() would fail to parse, landing in a .catch() that
    // redirects to /login. Always return clean JSON instead.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load billing status" }, { status: 500 });
  }
}
