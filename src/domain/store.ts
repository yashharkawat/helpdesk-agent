import { z } from "zod";
import seed from "@/data/seed.json";

export type Tier = "standard" | "plus";
export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

export interface Customer { id: string; name: string; email: string; tier: Tier; memberSinceDaysAgo: number }
export interface OrderItem { sku: string; name: string; qty: number; priceCents: number; finalSale: boolean }
export interface Order {
  id: string; customerId: string; placedDaysAgo: number; status: OrderStatus; deliveredDaysAgo: number | null;
  shipping: "standard" | "express"; carrier: string | null; tracking: string | null;
  items: OrderItem[]; shippingCents: number; totalCents: number; refundedCents: number;
}

export const CUSTOMERS = seed.customers as Customer[];
const ORDERS = seed.orders as Order[];

export const CUSTOMER_ID = /^C-\d{4}$/;
export const ORDER_ID = /^FH-\d{5}$/;

const idField = z.string().max(24);
const text = (max: number) => z.string().max(max);

/**
 * Everything a visitor changes lives in their own browser and rides along with each request:
 * no database, and one visitor can never see or affect another's sandbox.
 */
export const SandboxState = z.object({
  orders: z.record(idField, z.object({ status: z.enum(["processing", "shipped", "delivered", "cancelled"]).optional(), refundedCents: z.number().int().min(0).max(10_000_000).optional() })).default({}),
  refunds: z.array(z.object({ id: idField, orderId: idField, amountCents: z.number().int().min(1).max(10_000_000), reason: text(300) })).max(20).default([]),
  tickets: z.array(z.object({ id: idField, customerId: idField, subject: text(120), summary: text(600), priority: z.enum(["low", "normal", "high"]) })).max(20).default([]),
  escalations: z.array(z.object({ id: idField, customerId: idField, orderId: idField.nullable(), reason: text(300), summary: text(600) })).max(20).default([]),
});
export type SandboxState = z.infer<typeof SandboxState>;
export const emptyState = (): SandboxState => ({ orders: {}, refunds: [], tickets: [], escalations: [] });

/** One conversation's view of the business: who is signed in, and their sandbox. */
export interface Session {
  customerId: string;
  state: SandboxState;
  /** false only in the eval ablation that measures what happens when policy lives in the prompt alone. */
  enforcePolicy: boolean;
}

export const getCustomer = (id: string): Customer | undefined => CUSTOMERS.find((c) => c.id === id);

export function getOrder(session: Session, orderId: string): Order | undefined {
  const base = ORDERS.find((o) => o.id === orderId);
  if (!base) return undefined;
  return { ...base, ...session.state.orders[orderId] };
}

export const ordersFor = (session: Session, customerId: string): Order[] =>
  ORDERS.filter((o) => o.customerId === customerId).map((o) => ({ ...o, ...session.state.orders[o.id] }));

export function patchOrder(session: Session, orderId: string, patch: { status?: OrderStatus; refundedCents?: number }): void {
  session.state.orders[orderId] = { ...session.state.orders[orderId], ...patch };
}

export const nextId = (prefix: string, existing: Array<{ id: string }>): string => `${prefix}-${String(existing.length + 1).padStart(3, "0")}`;
export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
