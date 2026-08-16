"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Check, Loader2 } from "lucide-react";
import { PLANS, type PlanId } from "@/lib/plans";

const PLAN_FEATURES: Record<PlanId, string[]> = {
  starter: ["4,900 credits / month", "Full AI editing agent", "Layering, masking, captions", "Unlimited local footage"],
  creator: ["14,900 credits / month", "Everything in Starter", "More room for stock-clip generation", "Priority support"],
  studio: ["39,900 credits / month", "Everything in Creator", "Best for agencies / high volume", "Priority support"],
};

export default function PricingPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setChecking(false);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  const subscribe = async (plan: PlanId) => {
    setError(null);
    setLoadingPlan(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Couldn't start checkout");
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoadingPlan(null);
    }
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0c10]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0c10] px-4 py-12">
      <div className="mx-auto max-w-4xl">
        <div className="mb-10 flex flex-col items-center text-center">
          <Image src="/logo-white.png" alt="MONKe" width={168} height={115} className="h-10 w-auto" priority />
          <h1 className="mt-4 text-xl font-bold text-white">Choose a plan</h1>
          <p className="mt-1 text-[13px] text-gray-500">An active subscription is required to use MONKe.</p>
        </div>

        {error && <p className="mb-4 text-center text-[12px] text-red-400">{error}</p>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(Object.values(PLANS) as (typeof PLANS)[PlanId][]).map((plan) => (
            <div key={plan.id} className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-5">
              <h2 className="text-[15px] font-semibold text-white">{plan.name}</h2>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold text-white">RM{(plan.priceSen / 100).toFixed(0)}</span>
                <span className="text-[12px] text-gray-500">/mo</span>
              </div>
              <ul className="mt-4 flex flex-1 flex-col gap-2">
                {PLAN_FEATURES[plan.id].map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-[12px] text-gray-400">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#f26522]" />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => subscribe(plan.id)}
                disabled={loadingPlan !== null}
                className="mt-5 flex items-center justify-center gap-1.5 rounded-md bg-[#f26522] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[#d9541a] disabled:opacity-50 transition-colors"
              >
                {loadingPlan === plan.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Subscribe
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
