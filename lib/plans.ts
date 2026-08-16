// Subscription tiers. No free tier — the app requires an active
// subscription. Credits follow the SAME exchange rate MotionBoards
// already established (1 credit = RM0.01, i.e. price_sen === credits at
// purchase time) so the two products stay consistent for anyone using
// both. Margin lives entirely on the SPEND side (see lib/billing.ts's
// markup constants), not on the purchase rate — mirrors MotionBoards'
// chargeForGeneration + MARKUP_VIDEO_CREDITS pattern.
export type PlanId = "starter" | "creator" | "studio";

export interface Plan {
  id: PlanId;
  name: string;
  priceSen: number; // Stripe unit_amount, MYR sen (RM x 100)
  credits: number; // granted on signup and on every successful renewal
}

export const PLANS: Record<PlanId, Plan> = {
  starter: { id: "starter", name: "Starter", priceSen: 4900, credits: 4900 },
  creator: { id: "creator", name: "Creator", priceSen: 14900, credits: 14900 },
  studio: { id: "studio", name: "Studio", priceSen: 39900, credits: 39900 },
};

export function isPlanId(v: unknown): v is PlanId {
  return v === "starter" || v === "creator" || v === "studio";
}
