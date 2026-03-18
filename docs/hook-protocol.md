# Hook Protocol Specification

Farmer's hook protocol is agent-agnostic. Each hook endpoint accepts `POST` requests with a JSON body from `localhost` only (127.0.0.1 / ::1). No authentication is required for hook endpoints — they are protected by the localhost restriction. Warning: if farmer is configured to bind to `0.0.0.0` or any non-localhost address, hook endpoints become unauthenticated and network-exposed.

## Common Fields

Every hook payload should include:

| Field | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | No | Unique session identifier. If omitted, Farmer derives one from PID + CWD. |
| `cwd` | string | No | Working directory of the agent session |
| `pid` | number | No | Process ID of the agent (used for session binding) |

## POST /hooks/permission

**Blocking** — the response is held until the user approves/denies or the 120s timeout expires.

### Request Body

```json
{
  "session_id": "abc123",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/old" },
  "tool_use_id": "unique-request-id",
  "hook_event_name": "PreToolUse",
  "permission_mode": "default",
  "permission_suggestions": ["allow", "deny"],
  "cwd": "/path/to/project",
  "pid": 12345
}
```

### Response Body

The response format depends on the adapter. For Claude Code (PreToolUse):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Approved via Farmer"
  }
}
```

### AskUserQuestion Pattern

When `tool_name` is `AskUserQuestion`, the dashboard shows a text input. The response uses the **deny-to-respond** pattern: the tool is denied, and the user's answer is passed as `permissionDecisionReason`. This prevents the CLI from hanging on stdin while still delivering the response to the agent.

## POST /hooks/activity

**Non-blocking** — returns `{}` immediately.

Reports tool completion events (PostToolUse / PostToolUseFailure).

```json
{
  "session_id": "abc123",
  "tool_name": "Bash",
  "tool_input": { "command": "ls" },
  "tool_result": "file1.txt\nfile2.txt",
  "hook_event_name": "PostToolUse"
}
```

## POST /hooks/notification

**Non-blocking** — returns `{}` immediately.

Used for messages, agent events, and non-blocking questions.

```json
{
  "session_id": "abc123",
  "tool_name": "Message",
  "message": "I found 3 files matching your query.",
  "hook_event_name": "Notification"
}
```

## POST /hooks/lifecycle

**Non-blocking** — returns `{}` immediately.

Reports session start/end events.

```json
{
  "session_id": "abc123",
  "event": "session_start",
  "cwd": "/path/to/project",
  "source": "startup"
}
```

```json
{
  "session_id": "abc123",
  "event": "session_end",
  "reason": "user_exit"
}
```

## Dashboard API

These endpoints require token authentication (cookie or URL param) and CSRF token for mutations.

| Method | Path | Description |
|---|---|---|
| GET | `/events` | SSE stream (real-time push) |
| GET | `/api/state` | Full current state |
| POST | `/api/decide` | Approve/deny a pending permission |
| POST | `/api/trust-level` | Set trust level |
| POST | `/api/rules` | Add/remove auto-approve rules |
| POST | `/api/message` | Relay a message (localhost only) |
| POST | `/api/admin/rotate-token` | Rotate auth token |

## SSE

Connect to `/events?token=your-token-here` to receive real-time push updates. On connect, you receive an `init` message with full state. Subsequent messages are pushed as SSE `data:` frames. Polling via `/api/state` serves as automatic fallback.
