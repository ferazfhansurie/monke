import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getBillingInfo, creditsForGeneration } from "@/lib/billing";

export const maxDuration = 30;

// Text-to-video via ByteDance Ark (Seedance 2.0 Fast) — the same model/API
// MotionBoards uses for stock-style b-roll, called directly here (no
// MotionBoards middleman, no MotionBoards account/credits involved). This
// only SUBMITS the job — Ark generation takes ~2 minutes, far longer than
// this route's own budget, so the client polls /api/generate/video/status
// separately rather than waiting inline.
const ARK_MODEL = "dreamina-seedance-2-0-fast-260128";
const ARK_CREATE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const billing = await getBillingInfo(user.id);
  if (!billing?.subscriptionActive) {
    return NextResponse.json({ error: "Your MONKe subscription isn't active. Subscribe to generate clips.", code: "subscription_required" }, { status: 402 });
  }
  if (billing.credits < creditsForGeneration()) {
    return NextResponse.json({ error: `Not enough credits for a generation (needs ${creditsForGeneration()}, you have ${billing.credits}). Upgrade or wait for renewal.`, code: "out_of_credits" }, { status: 402 });
  }

  if (!process.env.ARK_API_KEY) {
    return NextResponse.json({ error: "Video generation isn't configured on this deployment (missing ARK_API_KEY)." }, { status: 500 });
  }

  try {
    const { prompt, durationSec, resolution, aspectRatio } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const duration = Math.max(4, Math.min(15, Math.round(Number(durationSec) || 5)));
    const res = typeof resolution === "string" && ["480p", "720p", "1080p"].includes(resolution) ? resolution : "720p";
    const ratio = typeof aspectRatio === "string" ? aspectRatio : "9:16";

    const arkRes = await fetch(ARK_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.ARK_API_KEY}` },
      body: JSON.stringify({
        model: ARK_MODEL,
        content: [{ type: "text", text: prompt }],
        ratio,
        resolution: res,
        duration,
        watermark: false,
        generate_audio: false,
      }),
    });
    const data = (await arkRes.json()) as Record<string, unknown>;
    if (!arkRes.ok) {
      const errObj = (data.error as Record<string, unknown>) || data;
      const msg = (errObj.message as string) || (errObj.code as string) || "Video generation submission failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    return NextResponse.json({ requestId: data.id as string });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Video generation request failed" }, { status: 500 });
  }
}
