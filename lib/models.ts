// Chat model catalog. Kept as an explicit allowlist (not a free-text field)
// so the client can only ever request a model the server is prepared to
// bill and serve — never an arbitrary string forwarded straight to Anthropic.

export interface ChatModelOption {
  id: string;
  label: string;
  description: string;
}

export const CHAT_MODELS: ChatModelOption[] = [
  { id: "claude-opus-5", label: "Opus 5", description: "Most capable — best for complex multi-clip edits" },
  { id: "claude-sonnet-5", label: "Sonnet 5", description: "Fast and strong — good default for everyday cuts" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", description: "Fastest and cheapest — simple one-step edits" },
];

export const DEFAULT_CHAT_MODEL = "claude-opus-5";

export function isValidChatModel(id: unknown): id is string {
  return typeof id === "string" && CHAT_MODELS.some((m) => m.id === id);
}
