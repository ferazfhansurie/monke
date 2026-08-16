import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { PLANS, isPlanId } from "@/lib/plans";
import { getBillingInfo, setStripeCustomerId } from "@/lib/billing";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const { plan } = await req.json();
    if (!isPlanId(plan)) return NextResponse.json({ error: "Invalid plan" }, { status: 400 });

    const stripe = getStripe();
    const billing = await getBillingInfo(user.id);
    let customerId = billing?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { monkeUserId: user.id } });
      customerId = customer.id;
      await setStripeCustomerId(user.id, customerId);
    }

    const planInfo = PLANS[plan];
    const origin = req.nextUrl.origin;
    // Prices are built inline (price_data) rather than referencing
    // pre-created Dashboard Prices — same pattern MotionBoards already uses,
    // no separate setup step to keep in sync when a plan's price changes.
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: "myr",
            product_data: { name: `MONKe ${planInfo.name}`, description: `${planInfo.credits.toLocaleString()} credits/month` },
            unit_amount: planInfo.priceSen,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      metadata: { monkeUserId: user.id, plan },
      subscription_data: { metadata: { monkeUserId: user.id, plan } },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/pricing?checkout=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Checkout failed" }, { status: 500 });
  }
}
