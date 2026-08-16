import Stripe from "stripe";

let stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not configured");
    // Same account MotionBoards uses — pinned to the same API version its
    // routes already use, so the two apps' Stripe integration stays in sync.
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" });
  }
  return stripe;
}
