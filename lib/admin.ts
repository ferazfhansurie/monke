// A single hardcoded admin account — not a roles system, just one specific
// email with (a) an auto-granted Starter subscription (skips Stripe
// checkout entirely) and (b) the ability to set its OWN credit balance
// directly, for testing without spending real money. No other account has
// either capability, and this account can only ever adjust its own
// balance, never another user's.
const ADMIN_EMAIL = "faeezree@gmail.com";

export function isAdminEmail(email: string): boolean {
  return email.trim().toLowerCase() === ADMIN_EMAIL;
}
