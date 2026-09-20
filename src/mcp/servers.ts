import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getArticle, searchKb } from "../core/kb";
import { checkRefund } from "../domain/policy";
import { ORDER_ID, getCustomer, getOrder, money, nextId, ordersFor, patchOrder, type Order, type Session } from "../domain/store";

/**
 * Three independent MCP servers, the way a real support stack is split across teams:
 *   kb      - read-only retrieval over the help center
 *   orders  - the order system (read + cancel)
 *   tickets - actions with consequences: refunds, tickets, human escalation
 *
 * Authorization is bound to the SESSION, never to a tool argument: the model cannot name
 * another customer, and every business rule is checked here rather than trusted to the prompt.
 */
export const SERVERS = {
  kb: { name: "fernhill-kb-mcp-server", version: "1.0.0" },
  orders: { name: "fernhill-orders-mcp-server", version: "1.0.0" },
  tickets: { name: "fernhill-tickets-mcp-server", version: "1.0.0" },
} as const;
export type ServerKey = keyof typeof SERVERS;

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const orderIdField = z.string().trim().toUpperCase().regex(ORDER_ID, 'order id like "FH-20401"').describe('Order id, e.g. "FH-20401"');

/** Returns the order only if it belongs to the signed-in customer. "Not found" is deliberately identical for both cases. */
function ownOrder(session: Session, orderId: string): Order | ToolResult {
  const order = getOrder(session, orderId);
  if (!order || (session.enforcePolicy && order.customerId !== session.customerId)) {
    return fail(`No order ${orderId} on this customer's account. Call orders_list_orders to see their orders, or ask the customer to re-check the number.`);
  }
  return order;
}

const describeOrder = (o: Order): string =>
  [
    `**${o.id}** - ${o.status}${o.deliveredDaysAgo !== null ? `, delivered ${o.deliveredDaysAgo} day(s) ago` : ""}, placed ${o.placedDaysAgo} day(s) ago`,
    ...o.items.map((i) => `- ${i.qty} x ${i.name} (${money(i.priceCents)})${i.finalSale ? " [FINAL SALE]" : ""}`),
    `Shipping: ${o.shipping}${o.carrier ? ` via ${o.carrier}, tracking ${o.tracking}` : ""} (${money(o.shippingCents)})`,
    `Total ${money(o.totalCents)}, refunded so far ${money(o.refundedCents)}`,
  ].join("\n");

export function registerKbTools(server: McpServer): void {
  server.registerTool(
    "kb_search_articles",
    {
      title: "Search the help center",
      description: "Search Fernhill Outfitters' help center for policy and how-to answers (returns, refunds, shipping, warranty, membership, product care). Returns the most relevant article sections with their article ids. Always ground policy statements in these results; cite the article id.",
      inputSchema: { query: z.string().trim().min(2).max(300).describe("What the customer is asking, in plain words"), limit: z.number().int().min(1).max(8).default(4) },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const hits = await searchKb(query, limit);
      if (hits.length === 0) return ok(`No help-center section matches "${query}". Try other wording.`, { results: [] });
      const text = hits.map((h, i) => `[${i + 1}] article "${h.chunk.articleId}" - ${h.chunk.title} > ${h.chunk.heading}\n${h.chunk.text}`).join("\n\n");
      return ok(text, { results: hits.map((h) => ({ article_id: h.chunk.articleId, title: h.chunk.title, heading: h.chunk.heading, text: h.chunk.text })) });
    },
  );

  server.registerTool(
    "kb_get_article",
    {
      title: "Read a full help-center article",
      description: "Return one complete help-center article by id (ids come from kb_search_articles). Use when a search hit is relevant but the section alone is not enough.",
      inputSchema: { article_id: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/).describe('Article id, e.g. "returns-policy"') },
      annotations: READ_ONLY,
    },
    async ({ article_id }) => {
      const a = await getArticle(article_id);
      return a ? ok(`# ${a.title}\n\n${a.body}`, { article_id: a.id, title: a.title, category: a.category }) : fail(`No article "${article_id}". Use kb_search_articles to find valid ids.`);
    },
  );
}

export function registerOrdersTools(server: McpServer, session: Session): void {
  server.registerTool(
    "orders_get_customer",
    { title: "Signed-in customer profile", description: "Profile of the customer in this conversation: name, membership tier (standard or plus) and tenure. The tier decides the return window.", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      const c = getCustomer(session.customerId);
      return c ? ok(`${c.name} (${c.id}) - ${c.tier} member for ${c.memberSinceDaysAgo} days, ${c.email}`, { ...c }) : fail("No customer is signed in.");
    },
  );

  server.registerTool(
    "orders_list_orders",
    { title: "List the customer's orders", description: "All orders on the signed-in customer's account, newest first, with status and totals. Use when the customer does not give an order number.", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      const list = ordersFor(session, session.customerId).sort((a, b) => a.placedDaysAgo - b.placedDaysAgo);
      return ok(list.map((o) => `- ${o.id}: ${o.status}, ${o.items.map((i) => i.name).join(" + ")}, ${money(o.totalCents)}, placed ${o.placedDaysAgo}d ago`).join("\n") || "No orders on this account.", { orders: list.map((o) => ({ id: o.id, status: o.status, total_cents: o.totalCents })) });
    },
  );

  server.registerTool(
    "orders_get_order",
    { title: "Order details", description: "Full details of one order on the signed-in customer's account: status, items (final-sale flags), delivery age in days, tracking, totals and amount already refunded. Call before any refund or cancellation.", inputSchema: { order_id: orderIdField }, annotations: READ_ONLY },
    async ({ order_id }) => {
      const o = ownOrder(session, order_id);
      return "content" in o ? o : ok(describeOrder(o), { ...o });
    },
  );

  server.registerTool(
    "orders_cancel_order",
    { title: "Cancel an order", description: 'Cancel an order. Only possible while its status is "processing"; shipped or delivered orders cannot be cancelled. Confirm with the customer before calling.', inputSchema: { order_id: orderIdField }, annotations: { ...WRITES, destructiveHint: true } },
    async ({ order_id }) => {
      const o = ownOrder(session, order_id);
      if ("content" in o) return o;
      if (session.enforcePolicy && o.status !== "processing") return fail(`Order ${o.id} is "${o.status}" and can no longer be cancelled. ${o.status === "shipped" ? "The customer can return it once it arrives." : ""}`.trim());
      patchOrder(session, o.id, { status: "cancelled" });
      return ok(`Order ${o.id} is cancelled. The card was never charged because charges happen at shipment.`, { order_id: o.id, status: "cancelled" });
    },
  );
}

export function registerTicketsTools(server: McpServer, session: Session): void {
  server.registerTool(
    "tickets_issue_refund",
    {
      title: "Refund an order",
      description: "Refund part or all of a delivered order to the original payment method. The server checks the return window, final-sale status, the refundable balance and the assistant approval limit, and refuses with the reason when a rule is not met. Amount is in cents.",
      inputSchema: {
        order_id: orderIdField,
        amount_cents: z.number().int().min(1).max(10_000_000).describe("Amount in cents, e.g. 6800 for $68.00"),
        reason: z.string().trim().min(3).max(300).describe("Why the refund is being issued, in the customer's terms"),
        damaged: z.boolean().default(false).describe("true only if the customer reports the item arrived damaged or defective"),
      },
      annotations: WRITES,
    },
    async ({ order_id, amount_cents, reason, damaged }) => {
      const o = ownOrder(session, order_id);
      if ("content" in o) return o;
      const customer = getCustomer(o.customerId)!;
      if (session.enforcePolicy) {
        const decision = checkRefund(o, customer, amount_cents, damaged);
        if (!decision.ok) return fail(`Refund refused (${decision.code}): ${decision.message}`);
      }
      const id = nextId("RF", session.state.refunds);
      session.state.refunds.push({ id, orderId: o.id, amountCents: amount_cents, reason });
      patchOrder(session, o.id, { refundedCents: o.refundedCents + amount_cents });
      return ok(`Refund ${id} approved: ${money(amount_cents)} on ${o.id}. It reaches the original payment method in 5-7 business days.`, { refund_id: id, order_id: o.id, amount_cents });
    },
  );

  server.registerTool(
    "tickets_escalate_to_human",
    {
      title: "Hand off to a human specialist",
      description: "Hand the case to a human specialist: refunds above the assistant limit, warranty claims, anything policy does not cover, or an upset customer. Specialists reply within 1 business day. Include everything they need so the customer is not asked twice.",
      inputSchema: { order_id: orderIdField.optional(), reason: z.string().trim().min(3).max(300).describe("Why a human is needed"), summary: z.string().trim().min(10).max(600).describe("Case summary: what happened, what the customer wants, what was already checked") },
      annotations: WRITES,
    },
    async ({ order_id, reason, summary }) => {
      if (order_id) {
        const o = ownOrder(session, order_id);
        if ("content" in o) return o;
      }
      const id = nextId("ESC", session.state.escalations);
      session.state.escalations.push({ id, customerId: session.customerId, orderId: order_id ?? null, reason, summary });
      return ok(`Escalation ${id} created. A specialist will reply within 1 business day (Mon-Fri 8am-6pm Mountain Time).`, { escalation_id: id });
    },
  );

  server.registerTool(
    "tickets_create_ticket",
    {
      title: "Open a support ticket",
      description: "Record an issue that needs follow-up but no immediate human decision (lost-package trace, address problem, feedback). For refunds over the limit or warranty claims use tickets_escalate_to_human instead.",
      inputSchema: { subject: z.string().trim().min(3).max(120), summary: z.string().trim().min(10).max(600), priority: z.enum(["low", "normal", "high"]).default("normal") },
      annotations: WRITES,
    },
    async ({ subject, summary, priority }) => {
      const id = nextId("TCK", session.state.tickets);
      session.state.tickets.push({ id, customerId: session.customerId, subject, summary, priority });
      return ok(`Ticket ${id} opened (${priority} priority).`, { ticket_id: id });
    },
  );
}

export const REGISTRARS: Record<ServerKey, (server: McpServer, session: Session) => void> = {
  kb: (server) => registerKbTools(server),
  orders: registerOrdersTools,
  tickets: registerTicketsTools,
};
