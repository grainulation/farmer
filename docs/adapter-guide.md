# Adapter Guide

Farmer is agent-agnostic. The adapter layer translates between an AI agent's specific hook format and Farmer's internal protocol.

## BaseAdapter Interface

Every adapter must extend `BaseAdapter` from `lib/adapters/base.js` and implement these methods:

### `get name()`

Returns a human-readable name for the adapter (e.g., "Claude Code").

### `parseRequest(body) -> object`

Parses a raw hook POST body into a normalized permission object:

```js
{
  requestId: string,      // Unique request ID
  toolName: string,       // Tool being called (e.g., "Bash", "Read")
  toolInput: object,      // Tool arguments
  sessionId: string|null, // Session identifier
  cwd: string|null,       // Working directory
  hookEvent: string,      // Hook event type (e.g., "PreToolUse")
  isQuestion: boolean,    // Is this a question/elicitation?
  permissionMode: string|null,
  suggestions: string[]|null,
  pid: number|null,
  raw: object,            // Original body (for adapter-specific needs)
}
```

### `formatResponse(decision, context) -> object`

Converts a decision into the agent-specific HTTP response body.

**decision:**

```js
{
  allow: boolean,
  reason: string,
  response: string  // For questions only
}
```

**context:**

```js
{
  hookEvent: string,   // e.g., "PreToolUse"
  isQuestion: boolean
}
```

### `getToolName(body) -> string`

Extracts the tool name from a raw hook body.

### `isQuestion(body) -> boolean`

Returns true if this hook payload is a question/elicitation tool.

### `parseNotification(body) -> object`

Parses a notification payload:

```js
{
  toolName: string,
  prompt: string,
  hookEvent: string
}
```

### `parseLifecycle(body) -> object` (optional)

Default implementation extracts `event`, `sessionId`, `cwd`, `source`, `reason` from the body. Override if your agent uses different field names.

## Example: Claude Code Adapter

See `lib/adapters/claude-code.js` for the reference implementation. Key behaviors:

1. **PreToolUse vs PermissionRequest**: Claude Code sends two different hook event formats. The adapter handles both.

2. **AskUserQuestion deny-to-respond**: When the user answers a question, the adapter responds with `permissionDecision: 'deny'` and puts the answer in `permissionDecisionReason`. This prevents the CLI from waiting on stdin.

3. **Notification parsing**: Claude Code sends tool name, prompts, and messages in various locations. The adapter tries multiple field paths to extract the prompt.

## Registering a Custom Adapter

Pass your adapter when creating the server:

```js
import { FarmerServer } from "@grainulation/farmer/lib/server.js";
import { MyAdapter } from "./my-adapter.js";

const server = new FarmerServer({
  port: 9090,
  adapter: new MyAdapter(),
});
server.start();
```
