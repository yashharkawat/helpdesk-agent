import { getCustomer } from "@/src/domain/store";
import { llmConfigured } from "@/src/agent/llm";
import { runAgent, type AgentEvent } from "@/src/agent/loop";
import { enforceRateLimit, parseJson, PublicError, toErrorResponse } from "@/src/server/http";
import { rateLimit } from "@/src/server/ratelimit";
import { ChatRequest } from "@/src/server/schemas";

export const runtime = "nodejs";
export const maxDuration = 120;

const DAILY_BUDGET = Number(process.env.HELPDESK_DAILY_TURN_BUDGET ?? 150);
const TURN_MS = 100_000;

/** Streams the agent's run as NDJSON: every tool call and result as it happens, then the answer and the new sandbox state. */
export async function POST(req: Request) {
  try {
    enforceRateLimit(req, "chat", 8, 60_000);
    const body = await parseJson(req, ChatRequest, 48 * 1024);
    if (!llmConfigured()) throw new PublicError(503, "The agent is not enabled on this deployment.");
    if (!getCustomer(body.customerId)) throw new PublicError(400, "Unknown customer.");
    if (!rateLimit("chat:global", DAILY_BUDGET, 86_400_000).ok) throw new PublicError(429, "Daily demo budget reached. Come back tomorrow.");

    const session = { customerId: body.customerId, state: body.state, enforcePolicy: true };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        try {
          await runAgent({ session, history: body.history, message: body.message, deadline: Date.now() + TURN_MS, emit });
        } catch (err) {
          console.error("[helpdesk] agent failure:", err);
          emit({ type: "error", message: "The free LLM providers are busy right now. Please try again in a moment." });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
