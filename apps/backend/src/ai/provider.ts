import Anthropic from "@anthropic-ai/sdk";

export type AiProvider = "claude" | "gemini" | "none";

export function aiProvider(): AiProvider {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "claude";
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  return "none";
}

let client: Anthropic | undefined;
export function claude(): Anthropic | undefined {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return undefined;
  client ??= new Anthropic({ apiKey: key, timeout: 20_000, maxRetries: 1 });
  return client;
}

export const claudeModel = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

export async function claudeJson<T>(opts: {
  system?: string;
  prompt: string;
  schema: object;
  name: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const c = claude();
  if (!c) throw new Error("Claude is not configured");
  const res = await c.messages.create(
    {
      model: claudeModel(),
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
      tools: [{ name: opts.name, description: "Return the structured result.", input_schema: opts.schema as any }],
      tool_choice: { type: "tool", name: opts.name },
    },
    opts.timeoutMs || opts.maxRetries !== undefined ? { ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}), ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}) } : undefined,
  );
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude returned no structured output");
  return block.input as T;
}
