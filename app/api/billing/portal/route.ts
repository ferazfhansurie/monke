import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { getBillingInfo } from "@/lib/billing";

// Self-serve cancellation + payment method management via Stripe's hosted
// portal. Plan switching isn't exposed here (would need pre-created,
// curated Stripe Prices for the portal's subscription-update UI to list —
// checkout instead builds prices inline per MotionBoards' existing
// pattern) — to change plans for now, cancel here and start a new
// subscription from /pricing.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const billing = await getBillingInfo(user.id);
    if (!billing?.stripeCustomerId) return NextResponse.json({ error: "No billing account yet" }, { status: 400 });

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: req.nextUrl.origin,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't open billing portal" }, { status: 500 });
  }
}
