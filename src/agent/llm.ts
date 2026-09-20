const OPENROUTER = "https://openrouter.ai/api/v1";
/** Tried in order, then any other free model whose catalogue entry advertises tool calling. */
const PREFERRED = ["deepseek/deepseek-v4-flash-0731:free", "qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free", "nvidia/nemotron-3-super-120b-a12b:free", "cohere/north-mini-code:free"];
const RETRYABLE = new Set([402, 404, 408, 429, 500, 502, 503, 504]);
const CALL_TIMEOUT_MS = 25_000;

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: string }
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };
export interface Completion { model: string; content: string; toolCalls: ToolCall[] }

/** Free-tier guard: a paid slug can never be sent, whatever the env or the catalogue says. */
export function assertFreeModel(model: string): string {
  if (!/^[\w.-]+\/[\w.:-]+:free$/.test(model)) throw new Error(`Refusing non-free model id "${model}"`);
  return model;
}

export const llmConfigured = (): boolean => Boolean(process.env.OPENROUTER_API_KEY);

let catalogue: { at: number; models: string[] } | null = null;

async function toolModels(fetchImpl: typeof fetch): Promise<string[]> {
  if (catalogue && Date.now() - catalogue.at < 3_600_000) return catalogue.models;
  let live: string[] = [];
  try {
    const res = await fetchImpl(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = ((await res.json()) as { data: Array<{ id: string; supported_parameters?: string[] }> }).data;
      live = data.filter((m) => m.id.endsWith(":free") && m.supported_parameters?.includes("tools")).map((m) => m.id);
    }
  } catch {
    /* fall back to the static list */
  }
  const models = live.length ? [...PREFERRED.filter((m) => live.includes(m)), ...live.filter((m) => !PREFERRED.includes(m))] : PREFERRED;
  catalogue = { at: Date.now(), models };
  return models;
}

/**
 * One non-streaming chat completion with tools. Rotates to the next free model on quota,
 * availability or timeout; `sticky` keeps a conversation on the model that last worked.
 */
export async function complete(messages: ChatMessage[], tools: ToolSpec[], opts: { sticky?: string; deadline: number; fetchImpl?: typeof fetch }): Promise<Completion> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("LLM not configured");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const all = await toolModels(fetchImpl);
  const order = opts.sticky && all.includes(opts.sticky) ? [opts.sticky, ...all.filter((m) => m !== opts.sticky)] : all;

  for (const model of order.slice(0, 5)) {
    const budget = Math.min(CALL_TIMEOUT_MS, opts.deadline - Date.now());
    if (budget < 3000) break;
    let res: Response;
    try {
      res = await fetchImpl(`${OPENROUTER}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Helpdesk Agent" },
        body: JSON.stringify({
          model: assertFreeModel(model),
          messages,
          tools: tools.map((t) => ({ type: "function", function: t })),
          tool_choice: "auto",
          max_tokens: 1200,
          temperature: 0.1,
          reasoning: { effort: "low", exclude: true },
        }),
        signal: AbortSignal.timeout(budget),
      });
    } catch {
      continue; // slow or unreachable: rotate
    }
    if (!res.ok) {
      if (RETRYABLE.has(res.status)) continue;
      break;
    }
    const body = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>; error?: unknown } | null;
    const msg = body?.choices?.[0]?.message;
    if (!msg) continue; // upstream error delivered with a 200
    const toolCalls = (msg.tool_calls ?? []).filter((c) => c.function?.name).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.function!.name!, arguments: c.function!.arguments || "{}" }));
    if (!toolCalls.length && !msg.content?.trim()) continue; // empty turn: try another model
    console.log(JSON.stringify({ event: "llm_call", model, tools: toolCalls.length }));
    return { model, content: msg.content?.trim() ?? "", toolCalls };
  }
  throw new Error("All free models unavailable");
}
