import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { DEFAULT_CHAT_MODEL, isValidChatModel } from "@/lib/models";
import { getBillingInfo, deductCredits, creditsForChatUsage } from "@/lib/billing";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export const maxDuration = 60;

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

export async function POST(req: NextRequest) {
  // Everything below (including requireUser/billing, both of which do DB
  // work) is inside this single try/catch — an uncaught exception anywhere
  // here previously produced Next.js's default HTML error page instead of
  // JSON, which the client would fail to parse. Whether that ever actually
  // fires isn't the point: a route that talks to a database and a 3rd-party
  // API must never let the client see anything but a clean JSON error.
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const billing = await getBillingInfo(user.id);
    if (!billing?.subscriptionActive) {
      return NextResponse.json({ error: "Your MONKe subscription isn't active. Subscribe to keep editing.", code: "subscription_required" }, { status: 402 });
    }
    if (billing.credits <= 0) {
      return NextResponse.json({ error: "You're out of credits for this billing period. Upgrade your plan or wait for renewal.", code: "out_of_credits" }, { status: 402 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "The editing agent isn't configured on this deployment yet (missing ANTHROPIC_API_KEY)." }, { status: 500 });
    }

    const { messages, timelineContext, model } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages is required" }, { status: 400 });
    }
    const resolvedModel = isValidChatModel(model) ? model : DEFAULT_CHAT_MODEL;

    const systemBlocks: Anthropic.TextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    if (typeof timelineContext === "string" && timelineContext.trim()) {
      systemBlocks.push({ type: "text", text: timelineContext.slice(0, 40000) });
    }

    const client = getAnthropic();
    const response = await client.messages.create({
      model: resolvedModel,
      max_tokens: 4096,
      system: systemBlocks,
      tools: AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: messages as Anthropic.MessageParam[],
    });

    const cost = creditsForChatUsage(resolvedModel, response.usage.input_tokens, response.usage.output_tokens);
    await deductCredits(user.id, cost);

    return NextResponse.json({ content: response.content, stop_reason: response.stop_reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
