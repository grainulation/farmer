import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeAdapter } from "../lib/adapters/claude-code.js";
import { BaseAdapter } from "../lib/adapters/base.js";

describe("BaseAdapter", () => {
  it("throws on unimplemented methods", () => {
    const base = new BaseAdapter();
    assert.throws(() => base.name, /must implement/);
    assert.throws(() => base.parseRequest({}), /must implement/);
    assert.throws(() => base.formatResponse({}, {}), /must implement/);
    assert.throws(() => base.getToolName({}), /must implement/);
    assert.throws(() => base.isQuestion({}), /must implement/);
    assert.throws(() => base.parseNotification({}), /must implement/);
  });

  it("provides default parseLifecycle", () => {
    const base = new BaseAdapter();
    const result = base.parseLifecycle({
      event: "session_start",
      session_id: "abc",
      cwd: "/tmp",
      source: "startup",
    });
    assert.equal(result.event, "session_start");
    assert.equal(result.sessionId, "abc");
    assert.equal(result.cwd, "/tmp");
    assert.equal(result.source, "startup");
  });

  it("provides default formatTimeoutResponse", () => {
    // We need a concrete adapter for this
    const adapter = new ClaudeCodeAdapter();
    const result = adapter.formatTimeoutResponse({ hookEvent: "PreToolUse" });
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      result.hookSpecificOutput.permissionDecisionReason.includes("timed out"),
    );
  });
});

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("has correct name", () => {
    assert.equal(adapter.name, "Claude Code");
  });

  describe("parseRequest", () => {
    it("parses a standard PreToolUse permission", () => {
      const body = {
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_use_id: "req-001",
        hook_event_name: "PreToolUse",
        session_id: "sess-1",
        cwd: "/project",
        pid: 1234,
      };
      const result = adapter.parseRequest(body);
      assert.equal(result.toolName, "Bash");
      assert.equal(result.requestId, "req-001");
      assert.equal(result.hookEvent, "PreToolUse");
      assert.equal(result.isQuestion, false);
      assert.equal(result.sessionId, "sess-1");
      assert.equal(result.cwd, "/project");
      assert.deepEqual(result.toolInput, { command: "ls -la" });
    });

    it("detects AskUserQuestion as a question", () => {
      const body = {
        tool_name: "AskUserQuestion",
        tool_input: { prompt: "What should I do?" },
        hook_event_name: "PreToolUse",
      };
      const result = adapter.parseRequest(body);
      assert.equal(result.isQuestion, true);
      assert.equal(result.toolName, "AskUserQuestion");
    });

    it("detects Request as a question", () => {
      const body = { tool_name: "Request", tool_input: { prompt: "Pick one" } };
      const result = adapter.parseRequest(body);
      assert.equal(result.isQuestion, true);
    });
  });

  describe("formatResponse", () => {
    it("formats PreToolUse allow", () => {
      const result = adapter.formatResponse(
        { allow: true, reason: "Approved" },
        { hookEvent: "PreToolUse", isQuestion: false },
      );
      assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
      assert.equal(
        result.hookSpecificOutput.permissionDecisionReason,
        "Approved",
      );
    });

    it("formats PreToolUse deny", () => {
      const result = adapter.formatResponse(
        { allow: false, reason: "Too risky" },
        { hookEvent: "PreToolUse", isQuestion: false },
      );
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(
        result.hookSpecificOutput.permissionDecisionReason,
        "Too risky",
      );
    });

    it("formats AskUserQuestion deny-to-respond pattern", () => {
      const result = adapter.formatResponse(
        { allow: false, response: "Use option B" },
        { hookEvent: "PreToolUse", isQuestion: true },
      );
      // Question response = deny + answer as reason
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(
        result.hookSpecificOutput.permissionDecisionReason,
        "Use option B",
      );
    });

    it("formats PermissionRequest allow", () => {
      const result = adapter.formatResponse(
        { allow: true, reason: "Go ahead" },
        { hookEvent: "PermissionRequest" },
      );
      assert.equal(
        result.hookSpecificOutput.hookEventName,
        "PermissionRequest",
      );
      assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    });

    it("formats PermissionRequest deny", () => {
      const result = adapter.formatResponse(
        { allow: false, reason: "Nope" },
        { hookEvent: "PermissionRequest" },
      );
      assert.equal(result.hookSpecificOutput.decision.behavior, "deny");
      assert.equal(result.hookSpecificOutput.decision.message, "Nope");
    });
  });

  describe("getToolName", () => {
    it("extracts tool name", () => {
      assert.equal(adapter.getToolName({ tool_name: "Bash" }), "Bash");
      assert.equal(adapter.getToolName({}), "");
    });
  });

  describe("isQuestion", () => {
    it("detects question tools", () => {
      assert.equal(adapter.isQuestion({ tool_name: "AskUserQuestion" }), true);
      assert.equal(adapter.isQuestion({ tool_name: "Request" }), true);
      assert.equal(adapter.isQuestion({ tool_name: "Bash" }), false);
      assert.equal(adapter.isQuestion({}), false);
    });
  });

  describe("parseNotification", () => {
    it("parses notification with tool_input.prompt", () => {
      const result = adapter.parseNotification({
        tool_name: "AskUserQuestion",
        tool_input: { prompt: "What now?" },
        hook_event_name: "Notification",
      });
      assert.equal(result.toolName, "AskUserQuestion");
      assert.equal(result.prompt, "What now?");
    });

    it("falls back to message field", () => {
      const result = adapter.parseNotification({
        message: "Hello from Claude",
      });
      assert.equal(result.toolName, "Message");
      assert.equal(result.prompt, "Hello from Claude");
    });

    it("uses Notification when no content", () => {
      const result = adapter.parseNotification({});
      assert.equal(result.toolName, "Notification");
      assert.equal(result.prompt, "");
    });
  });
});
