import { describe, expect, it } from "vitest";
import { connectServers } from "../src/agent/loop";
import { emptyState, type Session } from "../src/domain/store";

const newSession = (customerId: string, enforcePolicy = true): Session => ({ customerId, state: emptyState(), enforcePolicy });

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const { route, close } = await connectServers(session);
  try {
    const res = await route.get(name)!.client.callTool({ name, arguments: args });
    return { isError: Boolean(res.isError), text: (res.content as Array<{ text?: string }>).map((c) => c.text).join("\n") };
  } finally {
    await close();
  }
}

describe("MCP servers through the real client", () => {
  it("discovers every tool from the three servers via tools/list", async () => {
    const { tools, route, close } = await connectServers(newSession("C-1001"));
    await close();
    expect(tools.map((t) => t.name).sort()).toEqual(["kb_get_article", "kb_search_articles", "orders_cancel_order", "orders_get_customer", "orders_get_order", "orders_list_orders", "tickets_create_ticket", "tickets_escalate_to_human", "tickets_issue_refund"]);
    expect(new Set([...route.values()].map((r) => r.key))).toEqual(new Set(["kb", "orders", "tickets"]));
    expect(tools.every((t) => t.description.length > 40 && t.parameters.type === "object")).toBe(true);
  });

  it("binds authorization to the session: another customer's order looks like it does not exist", async () => {
    const mine = await call(newSession("C-1001"), "orders_get_order", { order_id: "FH-20401" });
    const theirs = await call(newSession("C-1001"), "orders_get_order", { order_id: "FH-20405" });
    const missing = await call(newSession("C-1001"), "orders_get_order", { order_id: "FH-99999" });
    expect(mine.isError).toBe(false);
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toBe(missing.text.replace("FH-99999", "FH-20405")); // no existence oracle
    expect((await call(newSession("C-1001"), "tickets_issue_refund", { order_id: "FH-20405", amount_cents: 500, reason: "asked nicely" })).isError).toBe(true);
  });

  it("enforces refund and cancellation rules in the server and records only what was allowed", async () => {
    const s = newSession("C-1001");
    expect((await call(s, "tickets_issue_refund", { order_id: "FH-20402", amount_cents: 8900, reason: "changed mind" })).text).toMatch(/outside_window/);
    expect((await call(s, "orders_cancel_order", { order_id: "FH-20404" })).text).toMatch(/can no longer be cancelled/);
    expect(s.state.refunds).toHaveLength(0);
    expect(s.state.orders).toEqual({});

    expect((await call(s, "tickets_issue_refund", { order_id: "FH-20401", amount_cents: 6000, reason: "does not fit" })).isError).toBe(false);
    expect((await call(s, "tickets_issue_refund", { order_id: "FH-20401", amount_cents: 6000, reason: "again" })).text).toMatch(/over_refundable/); // sandbox state carries forward
    expect(s.state.refunds.map((r) => r.amountCents)).toEqual([6000]);
  });

  it("rejects malformed arguments at the schema", async () => {
    const s = newSession("C-1001");
    const bad = await call(s, "tickets_issue_refund", { order_id: "../../etc/passwd", amount_cents: -5, reason: "x" }).catch((e: Error) => ({ isError: true, text: e.message }));
    expect(bad.isError).toBe(true);
    expect(s.state.refunds).toHaveLength(0);
  });
});
