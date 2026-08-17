import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { requireUser } from "@/lib/auth";
import { getBillingInfo, creditsForGeneration, deductCredits } from "@/lib/billing";
import { isAdminEmail } from "@/lib/admin";

export const maxDuration = 300;

// Text-to-video via Gemini Omni Flash (Google's Interactions API) — swapped
// in after ByteDance Ark started rejecting ARK_API_KEY as malformed (a
// platform-config problem, not something retrying fixes). Omni's
// background+poll-by-id mode was found unreliable in production
// (MotionBoards, 2026-07 — interaction ids couldn't always be re-fetched
// afterwards), so this runs synchronously instead: one blocking call that
// returns the finished video directly, no separate status poll. Ark can be
// swapped back in later (see /api/generate/video/status, left as-is) —
// nothing else in the app is tied to which provider this route uses.
const OMNI_MODEL = "gemini-omni-flash-preview";
const ALLOWED_DURATIONS = [4, 6, 8, 10];

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // The admin account (see lib/admin.ts) pays for Gemini generation
    // directly via its own GEMINI_API_KEY — MONKe's internal credit ledger
    // is a markup for other paying customers, not a real cost this account
    // needs to clear twice. Skip both the gate and the deduction for it.
    const isAdmin = isAdminEmail(user.email);

    const billing = await getBillingInfo(user.id);
    if (!isAdmin) {
      if (!billing?.subscriptionActive) {
        return NextResponse.json({ error: "Your MONKe subscription isn't active. Subscribe to generate clips.", code: "subscription_required" }, { status: 402 });
      }
      if (billing.credits < creditsForGeneration()) {
        return NextResponse.json({ error: `Not enough credits for a generation (needs ${creditsForGeneration()}, you have ${billing.credits}). Upgrade or wait for renewal.`, code: "out_of_credits" }, { status: 402 });
      }
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "Video generation isn't configured on this deployment (missing GEMINI_API_KEY)." }, { status: 500 });
    }

    const { prompt, durationSec, aspectRatio } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // Omni only accepts these exact duration targets (it's a target, not a
    // guarantee — the model picks the natural length) and one resolution —
    // clamp rather than pass through a value it would reject outright.
    const requestedDuration = Number(durationSec) || 8;
    const duration = ALLOWED_DURATIONS.reduce((closest, d) => (Math.abs(d - requestedDuration) < Math.abs(closest - requestedDuration) ? d : closest));
    const ratio = aspectRatio === "16:9" ? "16:9" : "9:16";

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const interaction = (await ai.interactions.create({
      model: OMNI_MODEL,
      input: [{ type: "text", text: prompt.trim() }],
      background: false,
      // URI video delivery requires a stored interaction even though this
      // call is awaited synchronously.
      store: true,
      response_format: { type: "video", aspect_ratio: ratio, duration: `${duration}s`, delivery: "uri" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as unknown as {
      id: string;
      output_video?: { data?: string; uri?: string; mime_type?: string };
    };

    const video = interaction.output_video;
    if (!video || (!video.data && !video.uri)) {
      return NextResponse.json({ status: "failed", error: "Google Omni returned no video. Try again with a shorter or simpler prompt." });
    }

    let videoDataUrl: string;
    if (video.data) {
      videoDataUrl = `data:${video.mime_type || "video/mp4"};base64,${video.data}`;
    } else {
      const videoRes = await fetch(video.uri!, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
      if (!videoRes.ok) return NextResponse.json({ status: "failed", error: `Couldn't download the generated video (${videoRes.status}).` });
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      videoDataUrl = `data:${videoRes.headers.get("content-type") || "video/mp4"};base64,${buffer.toString("base64")}`;
    }

    // Charged only on this success path, same principle the old Ark status
    // route used — nothing is deducted for a generation that didn't
    // actually deliver a video.
    if (!isAdmin) {
      await deductCredits(user.id, creditsForGeneration());
    }

    return NextResponse.json({ status: "completed", videoDataUrl });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Video generation request failed" }, { status: 500 });
  }
}
