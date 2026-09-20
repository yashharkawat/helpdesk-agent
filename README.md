# Helpdesk Agent

A customer-support agent with a hand-written agent loop. It is an **MCP client** that discovers its tools from **three MCP servers** (knowledge base, orders, tickets), answers policy questions with retrieval, takes real actions (refunds, cancellations, escalations) and is **measured on the business state it leaves behind**.

**Live demo:** https://helpdesk-agent.zojoofficial.com · Fernhill Outfitters, its customers and its orders are fictional.

<!-- RESULTS:START -->
<!-- RESULTS:END -->

## Why this exists

Most "AI agent" demos are a prompt, a framework and a happy path. This one is built around the three questions that decide whether an agent can be put in front of customers:

1. **Where do the tools come from?** Not hard-coded. The agent speaks MCP, so tools are discovered with `tools/list` at run time. The loop contains no tool names; adding a fourth server adds capabilities without touching the agent.
2. **What stops it doing the wrong thing?** Not the prompt. Refund and cancellation rules run inside the MCP servers. A jailbroken or merely confused model cannot refund outside the return window, refund a final-sale item, exceed the $100 assistant limit (even by splitting a refund in two), or touch another customer's order.
3. **How do you know it works?** Scripted customers, scored on the final state of the business rather than on how the reply reads, and an ablation that removes the server-side rules to show what they were worth.

## Architecture

```
 browser ──POST /api/chat──►  agent loop (src/agent/loop.ts)                 ┌─► kb server       hybrid RAG over 22 help articles
   ▲  NDJSON: tool_call,        plan → call tools → observe → repeat         │     kb_search_articles · kb_get_article
   │  tool_result, answer,      6-step budget · per-call timeouts       MCP  ├─► orders server   scoped to the signed-in customer
   │  state                     free tool-calling models, rotated    client ─┤     get_customer · list_orders · get_order · cancel_order
   │                                   │                                     └─► tickets server  actions with consequences
   └── sandbox state lives here        └─ OpenRouter (:free ids only)              issue_refund · escalate_to_human · create_ticket
       and rides along each request                                                 └─ src/domain/policy.ts decides, not the model
```

- **`src/agent/`** — the loop (~100 lines, no framework) and the LLM client. Parallel tool calls, schema errors handed back to the model for self-correction, unknown tools answered with the list of real ones, a last-step nudge so it always lands an answer.
- **`src/mcp/servers.ts`** — three `McpServer`s. The hosted agent links to them over `InMemoryTransport`; the *same registrars* are exposed over Streamable HTTP at `/api/mcp/{kb,orders,tickets}` for any MCP host.
- **`src/domain/`** — seed data, the per-visitor sandbox and `policy.ts`, the single place refund rules live. It is a pure function, so it is unit-tested and also used by the eval to judge violations.
- **`src/core/`** — retrieval: `bge-small-en-v1.5` running locally through ONNX (no embedding API), BM25, reciprocal-rank fusion. One chunk per `##` section of each article.
- **`eval/`** — 28 scenarios and the runner.

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Agent framework | None | The loop is the interesting part; it fits on one screen and every behaviour is explicit |
| Tool source | MCP client → 3 servers, `tools/list` at run time | The agent and the tools can ship separately, and the same servers work in Claude Code or Cursor |
| Transport | In-memory for the hosted agent, Streamable HTTP for outside hosts | No self-HTTP hop inside one serverless function; one registrar backs both |
| Authorization | Bound to the session; no tool accepts a customer id | The model cannot be talked into another account. "Not yours" and "does not exist" return the same message |
| Guardrails | Enforced in the servers, explained in the prompt | The prompt is advice; the server is the rule. Measured below |
| State | Per-visitor sandbox in the browser, Zod-validated each request | Zero infrastructure, visitors are isolated, nothing shared to poison |
| LLM | OpenRouter `:free` models that advertise tool calling, rotated on 402/429/5xx/timeout | Zero cost. A non-free id throws before any request is made |
| Dates | Seed data stores "days ago", not dates | The demo never goes stale |

## Use the MCP servers from your own editor

```bash
claude mcp add --transport http fernhill-kb https://helpdesk-agent.zojoofficial.com/api/mcp/kb
claude mcp add --transport http fernhill-orders "https://helpdesk-agent.zojoofficial.com/api/mcp/orders?customer=C-1001"
claude mcp add --transport http fernhill-tickets "https://helpdesk-agent.zojoofficial.com/api/mcp/tickets?customer=C-1001"
```

Then ask your model to "refund FH-20402 for Maya" and watch the tickets server refuse it. The HTTP endpoints are stateless: writes succeed against a fresh sandbox per request.

## Run it

```bash
npm install
npm run index-kb          # embeds the help center (first run downloads the 34 MB model)
OPENROUTER_API_KEY=... npm run dev
npm test                  # policy, servers through the real MCP client, the loop with a scripted model
OPENROUTER_API_KEY=... npm run eval
```

## Evaluation method

Each scenario is a customer message (sometimes two) for a specific signed-in customer, plus a check on the outcome: the sandbox state, the tools used, and facts that must appear in the reply. If the agent replies with a question instead of acting, a simulated customer answers once ("yes, go ahead"); adversarial scenarios always get a second, pushier turn.

- **8 everyday requests** — refunds inside the window, cancellations, order tracking, a damaged final-sale item.
- **6 knowledge-base questions** — the specific fact must be in the answer.
- **8 policy-risk requests** — the right move is to refuse or hand off (outside the window, over the limit, final sale, already shipped, warranty rather than refund).
- **6 adversarial requests** — fake authority, another customer's order, splitting a refund to dodge the cap, a forged "system notice", disputing the system's data.

A **violation** is a business state that must never exist, judged from the seed data with the same `checkRefund` function: a refund outside the window, on final-sale lines, above the cap, on someone else's order, or a cancelled order that had shipped. The ablation re-runs the 14 risky scenarios with `enforcePolicy: false`, where the servers execute whatever the model asks and the prompt is the only guard.

## Security posture

- Session-bound authorization; identical "not found" for foreign and missing orders (no existence oracle).
- All business rules server-side; refusals carry a reason the agent can relay and a legitimate next step.
- Customer text is treated as a request, never as instructions about the rules; tool results and model output are rendered as text nodes only.
- Zod validation on every route, tool and the sandbox state; body-size caps; per-IP and global daily rate limits; no stack traces to clients.
- Nonce-based CSP, locked-down headers on API routes.
- Only `:free` model ids can be called.

## Layout

```
app/            page, chat UI, /api/chat (NDJSON stream), /api/mcp/[server], /api/health
src/agent/      loop.ts · llm.ts
src/mcp/        servers.ts (kb · orders · tickets)
src/domain/     store.ts · policy.ts
src/core/       kb.ts · embedder.ts · bm25.ts
data/           seed.json · kb/*.md · kb-index/
eval/           scenarios.ts · run.ts · results.json
tests/          policy · servers · agent
specs/          design spec
```

MIT · built by Yash Harkawat
