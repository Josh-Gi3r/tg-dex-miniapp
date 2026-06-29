/**
 * ─── LLM relay (server-side) ─────────────────────────────────────────────────
 *
 * Single function `callLlm` that dispatches to Anthropic / OpenAI / Gemini
 * based on which API keys are configured. Mirrors the
 * dex-agents/templates/ai-assistant pattern but adapted for the dex-app
 * tRPC + Express environment.
 *
 * No keys in the browser — the user's tRPC client hits a protectedProcedure
 * which calls this server-side relay. The relay holds the API keys, makes
 * the upstream call, returns the assistant text.
 */

import type { LlmProvider } from "./pure";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const ANT_MODEL_DEFAULT = "claude-sonnet-4-6";
const OAI_MODEL_DEFAULT = "gpt-5.4-mini";
const GEM_MODEL_DEFAULT = "gemini-2.5-flash";

export async function callLlm(args: {
  provider: LlmProvider;
  messages: ChatMessage[];
  system: string;
  maxTokens?: number;
}): Promise<string> {
  const maxTokens = args.maxTokens ?? 600;
  switch (args.provider) {
    case "anthropic":
      return callAnthropic(args.messages, args.system, maxTokens);
    case "openai":
      return callOpenai(args.messages, args.system, maxTokens);
    case "gemini":
      return callGemini(args.messages, args.system, maxTokens);
  }
}

async function callAnthropic(messages: ChatMessage[], system: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const model = process.env.CLAUDE_MODEL ?? process.env.LLM_MODEL ?? ANT_MODEL_DEFAULT;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((j.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

async function callOpenai(messages: ChatMessage[], system: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const model = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? OAI_MODEL_DEFAULT;
  // OpenAI recommends the Responses API for GPT-5.x (reasoning models). The
  // system prompt goes in `instructions`; chat history in `input`. effort "low"
  // is recommended for latency-sensitive grounded chat (override via env).
  const effort = process.env.OPENAI_REASONING_EFFORT ?? "low";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      reasoning: { effort },
      max_output_tokens: maxTokens || 1500,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  // Don't assume output[0].content[0].text — aggregate all output_text items.
  if (typeof j.output_text === "string" && j.output_text.trim()) return j.output_text;
  let out = "";
  for (const item of j.output ?? []) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) if (c?.type === "output_text" && c.text) out += c.text;
    }
  }
  return out;
}

async function callGemini(messages: ChatMessage[], system: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? GEM_MODEL_DEFAULT;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
