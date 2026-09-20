import { NextResponse } from "next/server";
import { loadKb } from "@/src/core/kb";
import { llmConfigured } from "@/src/agent/llm";

export const runtime = "nodejs";

export async function GET() {
  const kb = await loadKb().catch(() => null);
  return NextResponse.json({ ok: Boolean(kb), kbChunks: kb?.chunks.length ?? 0, agentEnabled: llmConfigured() }, { status: kb ? 200 : 503 });
}
