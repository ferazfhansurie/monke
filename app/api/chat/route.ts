import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { DEFAULT_CHAT_MODEL, isValidChatModel } from "@/lib/models";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are the editing agent inside MONKe, a local-first AI video editor. The user's footage lives on their own machine — nothing was uploaded — and you can sequence, trim, split, reorder, and remove clips on their timeline using the tools available to you.

Ground every tool call in the CURRENT LIBRARY and CURRENT TIMELINE blocks you're given each turn — use the exact media/clip ids listed there, never invent one.

Be direct and brief. State what you're about to do in one short line before calling a tool, then a one-line result after. No filler, no "Happy to help!".

If the user asks for something you can't do yet (voiceover generation, captions, B-roll generation, transcription) say so plainly — don't pretend to do it.`;

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The editing agent isn't configured on this deployment yet (missing ANTHROPIC_API_KEY)." }, { status: 500 });
  }

  try {
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

    return NextResponse.json({ content: response.content, stop_reason: response.stop_reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
