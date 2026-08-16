import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export const maxDuration = 60;

const ARK_TASK_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

// Polls the Ark task and, once it succeeds, downloads the video server-side
// and relays it back as a base64 data URL in the same response — Ark's
// video_url is short-lived (~24h) and there's no reason to introduce
// server-side storage for it (MONKe keeps no media on the server), so the
// bytes get handed straight to the browser, exactly like a locally-imported
// file from that point on.
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!process.env.ARK_API_KEY) {
    return NextResponse.json({ error: "Video generation isn't configured on this deployment (missing ARK_API_KEY)." }, { status: 500 });
  }

  const requestId = req.nextUrl.searchParams.get("requestId");
  if (!requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });

  try {
    const taskRes = await fetch(`${ARK_TASK_URL}/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}` },
    });
    const task = (await taskRes.json()) as Record<string, unknown>;
    const status = (task.status as string) || "";

    if (status === "succeeded") {
      const content = task.content as Record<string, unknown> | undefined;
      const videoUrl = content?.video_url as string | undefined;
      if (!videoUrl) return NextResponse.json({ status: "failed", error: "No video URL returned by the generation provider." });

      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) return NextResponse.json({ status: "failed", error: `Couldn't fetch the generated video (${videoRes.status}).` });
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      if (buffer.length === 0) return NextResponse.json({ status: "failed", error: "The generated video download was empty." });
      const mimeType = videoRes.headers.get("content-type") || "video/mp4";
      const videoDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

      return NextResponse.json({ status: "completed", videoDataUrl });
    }

    if (status === "failed" || status === "expired") {
      const rawErr = task.error as Record<string, unknown> | string | undefined;
      const raw = typeof rawErr === "string" ? rawErr : (rawErr?.message as string) || (rawErr?.code as string) || `Generation ${status}`;
      let friendly = raw;
      if (/sensitive|safety|content|policy|violat|NSFW|prohibit/i.test(raw)) {
        friendly = "Blocked by the model's safety filter — try rephrasing the prompt.";
      } else if (/quota|limit|rate|429/i.test(raw)) {
        friendly = "Rate limited or out of quota on the generation provider — try again shortly.";
      }
      return NextResponse.json({ status: "failed", error: friendly });
    }

    return NextResponse.json({ status: "processing" });
  } catch (err) {
    return NextResponse.json({ status: "failed", error: err instanceof Error ? err.message : "Status check failed" });
  }
}
