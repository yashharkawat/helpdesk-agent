import { z } from "zod";
import { CUSTOMER_ID, SandboxState } from "../domain/store";

export const ChatRequest = z.object({
  customerId: z.string().regex(CUSTOMER_ID),
  message: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(12).default([]),
  state: SandboxState.default({ orders: {}, refunds: [], tickets: [], escalations: [] }),
});
export type ChatRequest = z.infer<typeof ChatRequest>;
