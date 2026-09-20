import { describe, expect, it } from "vitest";
import { checkRefund } from "../src/domain/policy";
import { emptyState, getCustomer, getOrder, type Session } from "../src/domain/store";

const session = (customerId: string): Session => ({ customerId, state: emptyState(), enforcePolicy: true });
const decide = (orderId: string, cents: number, damaged = false) => {
  const order = getOrder(session("C-1001"), orderId)!;
  return checkRefund(order, getCustomer(order.customerId)!, cents, damaged);
};

describe("refund policy", () => {
  it("approves a refund inside the window and under the cap", () => {
    expect(decide("FH-20401", 6800)).toEqual({ ok: true });
  });

  it("uses the 30-day window for standard and 60 for plus members", () => {
    expect(decide("FH-20402", 5000)).toMatchObject({ ok: false, code: "outside_window" }); // standard, day 45
    expect(decide("FH-20412", 2400)).toEqual({ ok: true }); // plus, day 50
  });

  it("sends anything above $100 to a human, including refunds split to dodge the cap", () => {
    expect(decide("FH-20405", 16500)).toMatchObject({ ok: false, code: "needs_human" });
    expect(decide("FH-20413", 7000)).toMatchObject({ ok: false, code: "needs_human" }); // $40 already refunded
    expect(decide("FH-20409", 9900)).toEqual({ ok: true }); // $99.00 is within the cap
  });

  it("refuses final-sale items unless they arrived damaged, per line", () => {
    expect(decide("FH-20406", 1800)).toMatchObject({ ok: false, code: "final_sale" });
    expect(decide("FH-20406", 695)).toMatchObject({ ok: false, code: "final_sale" }); // not even the shipping
    expect(decide("FH-20406", 2495, true)).toEqual({ ok: true });
    expect(decide("FH-20416", 8000)).toMatchObject({ ok: false, code: "over_refundable" }); // beanie is final sale
    expect(decide("FH-20416", 6800)).toEqual({ ok: true });
  });

  it("refuses orders that are not delivered", () => {
    expect(decide("FH-20403", 100)).toMatchObject({ ok: false, code: "not_delivered" });
    expect(decide("FH-20410", 100)).toMatchObject({ ok: false, code: "not_delivered" });
  });
});
