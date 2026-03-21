/**
 * Claude Code adapter — translates Claude Code's hook protocol
 * into Farmer's agent-agnostic internal format.
 *
 * Handles both PreToolUse and PermissionRequest hook event formats,
 * plus the AskUserQuestion deny-to-respond pattern.
 */

import { BaseAdapter } from "./base.js";

export class ClaudeCodeAdapter extends BaseAdapter {
  get name() {
    return "Claude Code";
  }

  parseRequest(body) {
    const toolName = body.tool_name || "";
    const toolInput = body.tool_input || {};
    const hookEvent = body.hook_event_name || "PermissionRequest";
    const isQuestion = toolName === "AskUserQuestion" || toolName === "Request";

    return {
      requestId: body.tool_use_id || null, // caller generates fallback
      toolName,
      toolInput,
      sessionId: body.session_id || null,
      cwd: body.cwd || null,
      hookEvent,
      isQuestion,
      permissionMode: body.permission_mode || null,
      suggestions: body.permission_suggestions || null,
      pid: body.pid || null,
      raw: body,
    };
  }

  formatResponse(decision, context) {
    const { hookEvent = "PermissionRequest", isQuestion = false } =
      context || {};

    if (hookEvent === "PreToolUse") {
      // AskUserQuestion: deny the tool, pass the answer as permissionDecisionReason
      // so Claude reads the response without waiting on stdin
      const isQuestionResponse = isQuestion && decision.response;
      const reasonText = isQuestionResponse
        ? decision.response
        : decision.response ||
          decision.reason ||
          (decision.allow ? "Approved via Farmer" : "Denied via Farmer");

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: isQuestionResponse
            ? "deny"
            : decision.allow
              ? "allow"
              : "deny",
          permissionDecisionReason: reasonText,
        },
      };
    }

    // PermissionRequest format (legacy)
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: decision.allow ? "allow" : "deny",
          message:
            decision.reason ||
            (decision.allow ? "Approved via Farmer" : "Denied via Farmer"),
        },
      },
    };
  }

  getToolName(body) {
    return body.tool_name || "";
  }

  isQuestion(body) {
    const toolName = this.getToolName(body);
    return toolName === "AskUserQuestion" || toolName === "Request";
  }

  formatStopResponse(feedbackText) {
    if (!feedbackText) return {};
    return {
      additionalContext: `[USER FEEDBACK from Farmer mobile dashboard]: "${feedbackText}" -- The user sent this from their phone. Acknowledge and act on this feedback.`,
    };
  }

  parseNotification(body) {
    const prompt =
      body.tool_input?.prompt ||
      body.tool_input?.question ||
      body.tool_input?.message ||
      body.message ||
      body.body ||
      body.notification?.message ||
      body.notification?.body ||
      (typeof body.tool_input === "string" ? body.tool_input : "") ||
      "";

    const toolName = body.tool_name || (prompt ? "Message" : "Notification");

    return {
      toolName,
      prompt,
      hookEvent: body.hook_event_name || "",
    };
  }
}
