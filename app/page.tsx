import Chat, { type Persona } from "./components/Chat";
import ThemeToggle from "./components/ThemeToggle";
import { CUSTOMERS, emptyState, money, ordersFor } from "@/src/domain/store";
import { llmConfigured } from "@/src/agent/llm";
import rawResults from "@/eval/results.json";

interface EvalConfig { id: string; label: string; passed: number; total: number; success: number; violations: number; adversarial: number; avgToolCalls: number; medianMs: number }
const results = rawResults as { date: string; scenarios: number; note: string; configs: EvalConfig[] };

const REPO_URL = "https://github.com/yashharkawat/helpdesk-agent";
const SITE = "https://helpdesk-agent.zojoofficial.com";

const SERVERS = [
  ["kb", "Knowledge base", "kb_search_articles · kb_get_article", "Hybrid retrieval (local embeddings + BM25, rank-fused) over 22 help-center articles. Read-only."],
  ["orders", "Order system", "orders_get_customer · orders_list_orders · orders_get_order · orders_cancel_order", "Scoped to the signed-in customer by the session, not by anything the model sends."],
  ["tickets", "Actions", "tickets_issue_refund · tickets_escalate_to_human · tickets_create_ticket", "Every refund is checked against the return window, final-sale lines, the refundable balance and the $100 assistant limit."],
];

const DESIGN = [
  ["The agent is an MCP client", "It connects to three MCP servers and learns its tools from the protocol's tools/list at run time. The loop contains no tool names, so adding a server adds capabilities without touching the agent."],
  ["A loop you can read", "Plan, call tools, observe, repeat — about 100 lines, no agent framework. Six-step budget, per-call timeouts, rotation across free tool-calling models, and schema errors are handed back so the model can correct itself."],
  ["Rules live in the servers", "The prompt explains policy, but the tickets server enforces it. A jailbroken or simply confused model still cannot refund outside the window, refund final-sale items, exceed $100, or touch another customer's order."],
  ["Measured, not demoed", "Scripted customer scenarios are scored on the final state of the business, not on how the reply sounds: was the right refund issued, was the wrong one blocked, was a human looped in."],
];

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function Home() {
  const personas: Persona[] = CUSTOMERS.map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    orders: ordersFor({ customerId: c.id, state: emptyState(), enforcePolicy: true }, c.id).map((o) => ({ id: o.id, status: o.status, label: o.items.map((i) => i.name).join(" + "), total: money(o.totalCents) })),
  }));
  const guarded = results.configs.find((c) => c.id === "guarded");
  const promptOnly = results.configs.find((c) => c.id === "prompt_only");

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-12 sm:py-16">
      <header>
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-sm text-accent">AI agent · MCP client + 3 servers · RAG</p>
          <ThemeToggle />
        </div>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Helpdesk Agent</h1>
        <p className="mt-4 max-w-3xl text-lg leading-8 text-gray-300">
          A customer-support agent that looks up orders, answers from the help center, issues refunds and knows when to hand off to a human. The
          agent loop is hand-written, the tools come from three MCP servers, and the rules it must not break are enforced where a prompt cannot reach them.
        </p>
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <a href={REPO_URL} className="rounded-lg bg-white px-4 py-2 font-medium text-ink hover:bg-gray-200">View source on GitHub</a>
          <a href="#servers" className="rounded-lg border border-edge px-4 py-2 font-medium text-gray-200 hover:border-accent">Use the MCP servers</a>
        </div>
        {guarded && (
          <>
            <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["Tasks resolved", pct(guarded.success)],
                ["Policy violations", `${guarded.violations} / ${guarded.adversarial}`],
                ["Same attacks, prompt-only rules", promptOnly ? `${promptOnly.violations} / ${promptOnly.adversarial}` : "—"],
                ["Tool calls per task", guarded.avgToolCalls.toFixed(1)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-edge bg-panel/60 px-4 py-4">
                  <dt className="text-xs uppercase tracking-wide text-gray-400">{k}</dt>
                  <dd className="mt-1 font-mono text-lg text-white">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-gray-500">{results.scenarios} scripted scenarios, scored on the resulting business state. Run {results.date} on free OpenRouter models.</p>
          </>
        )}
      </header>

      <div className="mt-12"><Chat personas={personas} enabled={llmConfigured()} /></div>

      <section aria-labelledby="design" className="mt-16">
        <h2 id="design" className="text-2xl font-semibold text-white">How it is built</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2">
          {DESIGN.map(([title, body], i) => (
            <li key={title} className="rounded-xl border border-edge bg-panel/60 p-5">
              <p className="font-mono text-xs text-accent">0{i + 1}</p>
              <h3 className="mt-1 font-semibold text-white">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-gray-300">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {guarded && promptOnly && (
        <section aria-labelledby="eval" className="mt-16">
          <h2 id="eval" className="text-2xl font-semibold text-white">Does enforcing rules in the server matter?</h2>
          <p className="mt-3 max-w-3xl leading-7 text-gray-300">
            The same agent, prompt and scenarios were run twice. In one run the tickets and orders servers enforce policy; in the other they
            execute whatever the model asks, so the prompt is the only guard. A violation is a business state that should never exist: a refund
            outside the return window, on a final-sale item, above the limit, or a cancelled order that had already shipped.
          </p>
          <div className="mt-6 overflow-x-auto rounded-xl border border-edge">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-edge text-xs uppercase tracking-wide text-gray-400">
                <tr><th className="px-4 py-3">Configuration</th><th className="px-4 py-3 text-right">Tasks resolved</th><th className="px-4 py-3 text-right">Policy violations</th><th className="px-4 py-3 text-right">Avg tool calls</th><th className="px-4 py-3 text-right">Median turn</th></tr>
              </thead>
              <tbody className="divide-y divide-edge text-gray-200">
                {results.configs.map((c) => (
                  <tr key={c.id} className={c.id === "guarded" ? "bg-emerald-950/30" : undefined}>
                    <td className="px-4 py-3">{c.label}</td>
                    <td className="px-4 py-3 text-right font-mono">{c.passed}/{c.total} ({pct(c.success)})</td>
                    <td className="px-4 py-3 text-right font-mono">{c.violations}/{c.adversarial}</td>
                    <td className="px-4 py-3 text-right font-mono">{c.avgToolCalls.toFixed(1)}</td>
                    <td className="px-4 py-3 text-right font-mono">{(c.medianMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-gray-400">{results.note}</p>
        </section>
      )}

      <section aria-labelledby="servers" className="mt-16">
        <h2 id="servers" className="text-2xl font-semibold text-white">Three MCP servers, usable on their own</h2>
        <p className="mt-3 max-w-3xl text-gray-300">The hosted agent talks to them in-process. The same servers are exposed over Streamable HTTP, so you can plug them into Claude Code or Cursor and let your own model run the desk:</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-edge bg-panel px-4 py-3 font-mono text-sm text-gray-200"><code>{`claude mcp add --transport http fernhill-kb ${SITE}/api/mcp/kb
claude mcp add --transport http fernhill-orders "${SITE}/api/mcp/orders?customer=C-1001"
claude mcp add --transport http fernhill-tickets "${SITE}/api/mcp/tickets?customer=C-1001"`}</code></pre>
        <ul className="mt-6 divide-y divide-edge rounded-xl border border-edge">
          {SERVERS.map(([key, title, tools, desc]) => (
            <li key={key} className="px-4 py-3">
              <p className="text-sm"><code className="font-mono text-accent">{key}</code> <span className="text-gray-200">· {title}</span></p>
              <p className="mt-1 font-mono text-xs text-gray-400">{tools}</p>
              <p className="mt-1 text-sm text-gray-300">{desc}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="security" className="mt-16">
        <h2 id="security" className="text-2xl font-semibold text-white">Security posture</h2>
        <ul className="mt-4 grid gap-x-8 gap-y-2 text-sm leading-6 text-gray-300 sm:grid-cols-2">
          <li>Authorization comes from the session. No tool takes a customer id, so the model cannot be talked into reading someone else&apos;s order.</li>
          <li>Refund and cancellation rules run inside the MCP servers and return the reason on refusal, which the agent relays.</li>
          <li>Each visitor&apos;s changes live in their own browser and are schema-validated on every request. There is no shared database to poison.</li>
          <li>Zod validation on every route and tool, body-size caps, per-IP and global daily rate limits, no stack traces to clients.</li>
          <li>Nonce-based CSP; model output and tool results are rendered as text nodes only.</li>
          <li>Only <code className="font-mono">:free</code> model ids can be called — a paid slug throws before any request is made.</li>
        </ul>
      </section>

      <footer className="mt-16 border-t border-edge pt-6 text-sm text-gray-500">
        Built by Yash Harkawat · Fernhill Outfitters and its customers are fictional · <a href={REPO_URL} className="underline hover:text-gray-300">source, design spec and eval scenarios</a>
      </footer>
    </main>
  );
}
