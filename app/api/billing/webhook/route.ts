import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { activateSubscription, renewSubscription, deactivateSubscription, changePlan, getUserIdByStripeCustomerId } from "@/lib/billing";
import { isPlanId } from "@/lib/plans";

export const maxDuration = 30;

// Unlike MotionBoards' webhook handler, this NEVER falls back to unsigned
// JSON.parse if STRIPE_WEBHOOK_SECRET is unset — an unverified webhook body
// is an unauthenticated way to grant credits, not an acceptable "dev mode".
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.monkeUserId;
        const plan = session.metadata?.plan;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (userId && isPlanId(plan) && subscriptionId) {
          await activateSubscription(userId, plan, subscriptionId);
        } else {
          console.error("checkout.session.completed missing required metadata", { userId, plan, subscriptionId });
        }
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription };
        // The first invoice on a new subscription is already handled by
        // checkout.session.completed — only renewals top up here.
        if (invoice.billing_reason === "subscription_create") break;
        const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
        if (subscriptionId) await renewSubscription(subscriptionId);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const plan = sub.metadata?.plan;
        if (isPlanId(plan)) await changePlan(sub.id, plan);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await deactivateSubscription(sub.id);
        break;
      }
      case "invoice.payment_failed": {
        // No dunning flow yet — self-expiring subscription_expires_at
        // means access lapses naturally at period end if payment never
        // succeeds; logged for visibility, not acted on.
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const userId = await getUserIdByStripeCustomerId(customerId);
          console.warn("Payment failed for user", userId, "invoice", invoice.id);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`Failed handling webhook event ${event.type}:`, err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
