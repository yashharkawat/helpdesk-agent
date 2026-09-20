import { createMcpHandler } from "mcp-handler";
import { REGISTRARS, SERVERS, type ServerKey } from "@/src/mcp/servers";
import { CUSTOMER_ID, emptyState, getCustomer } from "@/src/domain/store";
import { enforceRateLimit, PublicError, toErrorResponse } from "@/src/server/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Each of the three servers is also reachable over Streamable HTTP, so any MCP host (Claude Code,
 * Cursor) can use them directly: /api/mcp/kb, /api/mcp/orders?customer=C-1001, /api/mcp/tickets?customer=C-1001.
 * Stateless: writes succeed against a fresh sandbox per request and are not persisted.
 */
async function handler(req: Request, ctx: { params: Promise<{ server: string }> }): Promise<Response> {
  try {
    enforceRateLimit(req, "mcp", 60, 60_000);
    const { server: key } = await ctx.params;
    if (!Object.hasOwn(SERVERS, key)) throw new PublicError(404, `Unknown server. Use one of: ${Object.keys(SERVERS).join(", ")}.`);
    const customerId = new URL(req.url).searchParams.get("customer") ?? "C-1001";
    if (!CUSTOMER_ID.test(customerId) || !getCustomer(customerId)) throw new PublicError(400, "Unknown customer id.");
    const session = { customerId, state: emptyState(), enforcePolicy: true };
    const k = key as ServerKey;
    return await createMcpHandler((server) => REGISTRARS[k](server, session), { serverInfo: SERVERS[k] })(req);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export { handler as GET, handler as POST, handler as DELETE };
