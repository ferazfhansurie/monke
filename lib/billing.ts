import { neon } from "@neondatabase/serverless";
import { PLANS, type PlanId } from "./plans";
import { isAdminEmail } from "./admin";

type SqlRow = Record<string, unknown>;
type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRow[]>;

const sql: SqlFn = (strings, ...values) => {
  const fn = neon(process.env.DATABASE_URL!);
  return fn(strings, ...values) as Promise<SqlRow[]>;
};

let columnsEnsured = false;
async function ensureBillingColumns() {
  if (columnsEnsured) return;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS plan TEXT`;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS subscription_active BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ`;
  await sql`ALTER TABLE monke_users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS monke_users_stripe_subscription_id_idx ON monke_users (stripe_subscription_id)`;
  await sql`CREATE INDEX IF NOT EXISTS monke_users_stripe_customer_id_idx ON monke_users (stripe_customer_id)`;
  columnsEnsured = true;
}

export interface BillingInfo {
  plan: PlanId | null;
  credits: number;
  subscriptionActive: boolean;
  subscriptionExpiresAt: string | null;
  stripeCustomerId: string | null;
}

function rowToBillingInfo(row: SqlRow): BillingInfo {
  const expiresAt = row.subscription_expires_at as Date | null;
  return {
    plan: (row.plan as PlanId | null) ?? null,
    credits: Number(row.credits ?? 0),
    // Self-expiring, same as MotionBoards: don't rely solely on webhook
    // delivery for "deleted" events — if the period end has passed without
    // a renewal webhook landing, treat it as inactive regardless of the flag.
    subscriptionActive: Boolean(row.subscription_active) && !!expiresAt && expiresAt.getTime() > Date.now(),
    subscriptionExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
  };
}

export async function getBillingInfo(userId: string): Promise<BillingInfo | undefined> {
  await ensureBillingColumns();
  const rows = await sql`SELECT plan, credits, subscription_active, subscription_expires_at, stripe_customer_id FROM monke_users WHERE id = ${userId}`;
  return rows.length > 0 ? rowToBillingInfo(rows[0]) : undefined;
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string): Promise<void> {
  await ensureBillingColumns();
  await sql`UPDATE monke_users SET stripe_customer_id = ${stripeCustomerId} WHERE id = ${userId}`;
}

export async function getUserIdByStripeCustomerId(stripeCustomerId: string): Promise<string | undefined> {
  await ensureBillingColumns();
  const rows = await sql`SELECT id FROM monke_users WHERE stripe_customer_id = ${stripeCustomerId}`;
  return rows.length > 0 ? (rows[0].id as string) : undefined;
}

export async function getUserIdByStripeSubscriptionId(stripeSubscriptionId: string): Promise<string | undefined> {
  await ensureBillingColumns();
  const rows = await sql`SELECT id FROM monke_users WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
  return rows.length > 0 ? (rows[0].id as string) : undefined;
}

// Called on checkout.session.completed — first activation of a subscription.
// Grants that plan's monthly credit allowance and starts a 30-day window,
// mirroring MotionBoards' activateSubscription exactly (accumulate, never
// clobber existing credits).
export async function activateSubscription(userId: string, plan: PlanId, stripeSubscriptionId: string): Promise<void> {
  await ensureBillingColumns();
  const grant = PLANS[plan].credits;
  await sql`
    UPDATE monke_users
    SET plan = ${plan},
        stripe_subscription_id = ${stripeSubscriptionId},
        subscription_active = TRUE,
        subscription_expires_at = NOW() + INTERVAL '30 days',
        credits = credits + ${grant}
    WHERE id = ${userId}
  `;
}

// Called on invoice.payment_succeeded for a renewal (not the initial
// checkout, which activateSubscription already handles) — extends the
// window and tops up credits by whatever the user's CURRENT plan grants
// (so an upgrade mid-cycle takes effect at the next renewal, not retroactively).
export async function renewSubscription(stripeSubscriptionId: string): Promise<void> {
  await ensureBillingColumns();
  const rows = await sql`SELECT id, plan FROM monke_users WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
  if (rows.length === 0) return;
  const plan = rows[0].plan as PlanId | null;
  const grant = plan ? PLANS[plan].credits : 0;
  await sql`
    UPDATE monke_users
    SET subscription_expires_at = NOW() + INTERVAL '30 days',
        credits = credits + ${grant}
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
  `;
}

// customer.subscription.updated — plan change (upgrade/downgrade). Only
// updates which plan is on file; credits adjust at the next renewal rather
// than trying to prorate mid-cycle.
export async function changePlan(stripeSubscriptionId: string, plan: PlanId): Promise<void> {
  await ensureBillingColumns();
  await sql`UPDATE monke_users SET plan = ${plan} WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
}

// customer.subscription.deleted — only flips the active flag. Credits
// already granted are never clawed back (same as MotionBoards).
export async function deactivateSubscription(stripeSubscriptionId: string): Promise<void> {
  await ensureBillingColumns();
  await sql`UPDATE monke_users SET subscription_active = FALSE WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
}

// Atomic — only succeeds if the balance actually covers it, so concurrent
// requests can't drive credits negative.
export async function deductCredits(userId: string, amount: number): Promise<boolean> {
  await ensureBillingColumns();
  const rows = await sql`
    UPDATE monke_users SET credits = credits - ${amount}
    WHERE id = ${userId} AND credits >= ${amount}
    RETURNING credits
  `;
  return rows.length > 0;
}

// Sets an ABSOLUTE credit balance — only ever called for the single admin
// account (lib/admin.ts), and only ever on that account's own id. Every
// caller must itself verify isAdminEmail before reaching here; this
// function has no way to know who's asking.
export async function setCredits(userId: string, credits: number): Promise<void> {
  await ensureBillingColumns();
  await sql`UPDATE monke_users SET credits = ${Math.max(0, Math.round(credits))} WHERE id = ${userId}`;
}

// Auto-grants the admin account a Starter subscription the first time it's
// seen with no active subscription — skips Stripe checkout entirely, since
// this one account is for testing, not a real paying customer. Idempotent:
// once active, calling again is a no-op, so it never repeatedly re-grants
// credits on every request. Uses a synthetic (non-Stripe) subscription id
// so webhook-driven lookups by real Stripe subscription ids never collide
// with it.
export async function ensureAdminGrant(userId: string, email: string): Promise<void> {
  if (!isAdminEmail(email)) return;
  const info = await getBillingInfo(userId);
  if (info?.subscriptionActive) return;
  await activateSubscription(userId, "starter", `admin_grant_${userId}`);
}

// --- Credit math -----------------------------------------------------
// Provisional rates — no real usage telemetry yet. Tune MODEL_RATES_USD,
// USD_TO_MYR, and the markup constants once actual cost data exists;
// nothing else in the billing flow needs to change when they're updated.

const MODEL_RATES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};
const USD_TO_MYR = 4.7;
const CHAT_MARKUP = 5;
const GENERATION_COST_MYR = 2.5; // Ark's real per-clip cost, ballpark from MotionBoards' own pricing
const GENERATION_MARKUP = 3;

export function creditsForChatUsage(model: string, inputTokens: number, outputTokens: number): number {
  const rates = MODEL_RATES_USD_PER_MTOK[model] ?? MODEL_RATES_USD_PER_MTOK["claude-sonnet-5"];
  const costUsd = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  const costMyr = costUsd * USD_TO_MYR;
  return Math.max(1, Math.ceil(costMyr * 100 * CHAT_MARKUP));
}

export function creditsForGeneration(): number {
  return Math.ceil(GENERATION_COST_MYR * 100 * GENERATION_MARKUP);
}
