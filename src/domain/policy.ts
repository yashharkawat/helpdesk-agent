import { money, type Customer, type Order } from "./store";

/** Canonical policy numbers. The help-center articles state the same facts in prose. */
export const AGENT_REFUND_CAP_CENTS = 10_000;
export const RETURN_WINDOW_DAYS = { standard: 30, plus: 60 } as const;

export type RefundDecision =
  | { ok: true }
  | { ok: false; code: "not_delivered" | "outside_window" | "final_sale" | "over_refundable" | "needs_human"; message: string };

/**
 * The single place refund rules are enforced. It runs inside the tickets MCP server, so no
 * prompt, jailbreak or confused model can approve a refund the business would not.
 */
export function checkRefund(order: Order, customer: Customer, amountCents: number, damaged: boolean): RefundDecision {
  if (order.status !== "delivered" || order.deliveredDaysAgo === null) {
    return { ok: false, code: "not_delivered", message: `Order ${order.id} is "${order.status}", so nothing can be refunded yet. ${order.status === "processing" ? "It can still be cancelled with orders_cancel_order." : "Refunds are possible once it is delivered."}` };
  }
  const window = RETURN_WINDOW_DAYS[customer.tier];
  if (order.deliveredDaysAgo > window) {
    return { ok: false, code: "outside_window", message: `Delivered ${order.deliveredDaysAgo} days ago; the return window for ${customer.tier} members is ${window} days. Do not refund. If the customer reports a manufacturing defect, this may be a warranty claim: escalate with tickets_escalate_to_human.` };
  }
  // Final-sale lines are refundable only when damaged, so they are carved out of the refundable balance.
  const finalSaleCents = damaged ? 0 : order.items.filter((i) => i.finalSale).reduce((sum, i) => sum + i.qty * i.priceCents, 0);
  const refundable = order.totalCents - finalSaleCents - order.refundedCents;
  if (!damaged && (order.items.every((i) => i.finalSale) || (refundable <= 0 && finalSaleCents > 0))) {
    return { ok: false, code: "final_sale", message: `Every item on ${order.id} is final sale, which is refundable only when it arrived damaged or defective (set damaged=true only if the customer says so).` };
  }
  if (amountCents > refundable) {
    return { ok: false, code: "over_refundable", message: `Requested ${money(amountCents)} but only ${money(Math.max(0, refundable))} of ${order.id} is refundable (total ${money(order.totalCents)}, already refunded ${money(order.refundedCents)}${finalSaleCents ? `, final-sale items ${money(finalSaleCents)} excluded` : ""}).` };
  }
  // The cap is per order, so two $60 refunds cannot add up to what one $120 refund may not.
  if (order.refundedCents + amountCents > AGENT_REFUND_CAP_CENTS) {
    return { ok: false, code: "needs_human", message: `${money(order.refundedCents + amountCents)} in refunds on this order is above the ${money(AGENT_REFUND_CAP_CENTS)} limit an assistant can approve. Call tickets_escalate_to_human so a specialist can approve it, and tell the customer they will hear back within 1 business day.` };
  }
  return { ok: true };
}
