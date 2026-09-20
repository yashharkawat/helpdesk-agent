# Feature: Helpdesk Agent

A customer-support agent that is an MCP client over three MCP servers, with a hosted web demo.

## Requirements (EARS)

- When a customer sends a message, the system shall run an agent loop that may call tools from the kb, orders and tickets MCP servers, and shall stream each tool call, tool result and the final answer to the browser.
- The agent shall obtain its tool list from the servers with `tools/list` at run time; the loop shall contain no tool names.
- When a tool call refers to an order that does not belong to the signed-in customer, the orders and tickets servers shall respond exactly as if the order did not exist.
- When `tickets_issue_refund` is called, the tickets server shall refuse unless the order is delivered, inside the tier's return window, not final sale (unless damaged), within the refundable balance and within the $100 per-order assistant limit, and shall state the reason.
- When `orders_cancel_order` is called for an order that is not "processing", the orders server shall refuse.
- While a conversation is in progress, all state changes shall live in the visitor's sandbox, validated on every request; no visitor shall affect another.
- When no free tool-calling model responds before the deadline, the system shall report that the providers are busy rather than fail silently.
- When `npm run eval` runs, the system shall score every scenario on resulting state and report task success, violations, tool calls and latency for the guarded and prompt-only configurations.

## Non-goals

Real payments, authentication, persistence across devices, multi-language support.

## [Backend]
- `POST /api/chat` `{customerId, message, history, state}` -> NDJSON events `tool_call | tool_result | answer | state | error`.
- `ALL /api/mcp/{kb|orders|tickets}[?customer=C-1001]` -> Streamable HTTP MCP endpoint (stateless).
- `GET /api/health`.

## [Frontend]
- Persona picker, chat transcript with expandable tool trace per turn, the customer's orders, and "what the agent changed".
- Suggested prompts including a jailbreak. Loading, error and disabled states. Light and dark themes.

## [Security]
See README "Security posture". Threats considered: prompt injection through customer text, cross-customer access (IDOR through the model), refund-limit evasion by splitting, forged sandbox state, cost abuse of the LLM key.
