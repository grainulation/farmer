/**
 * Base adapter interface for agent-agnostic hook protocol.
 *
 * Every agent adapter must implement these methods to normalize
 * between agent-specific hook payloads and Farmer's internal format.
 */

export class BaseAdapter {
  /** Human-readable name for this adapter (e.g. "Claude Code") */
  get name() {
    throw new Error('Adapter must implement .name');
  }

  /**
   * Parse an incoming hook request body into a normalized permission object.
   *
   * @param {object} body - Raw JSON body from the hook POST
   * @returns {{ requestId: string, toolName: string, toolInput: object|string,
   *             sessionId: string|null, cwd: string|null, hookEvent: string,
   *             isQuestion: boolean, permissionMode: string|null,
   *             suggestions: string[]|null, pid: number|null,
   *             raw: object }}
   */
  parseRequest(body) {
    throw new Error('Adapter must implement parseRequest()');
  }

  /**
   * Format a decision into the agent-specific HTTP response body.
   *
   * @param {object} decision - { allow: boolean, reason: string, response?: string }
   * @param {object} context  - { hookEvent: string, isQuestion: boolean }
   * @returns {object} JSON-serializable response body
   */
  formatResponse(decision, context) {
    throw new Error('Adapter must implement formatResponse()');
  }

  /**
   * Format a timeout deny response.
   *
   * @param {object} context - { hookEvent: string }
   * @returns {object} JSON-serializable response body
   */
  formatTimeoutResponse(context) {
    return this.formatResponse(
      { allow: false, reason: 'Remote approval timed out after 120s' },
      context
    );
  }

  /**
   * Format an auto-approve response.
   *
   * @param {string} reason - Why it was auto-approved
   * @param {object} context - { hookEvent: string }
   * @returns {object} JSON-serializable response body
   */
  formatAutoApproveResponse(reason, context) {
    return this.formatResponse({ allow: true, reason }, context);
  }

  /**
   * Extract the tool name from a raw hook body.
   *
   * @param {object} body - Raw JSON body
   * @returns {string}
   */
  getToolName(body) {
    throw new Error('Adapter must implement getToolName()');
  }

  /**
   * Detect whether this hook payload is a question/elicitation
   * (AskUserQuestion or equivalent).
   *
   * @param {object} body - Raw JSON body
   * @returns {boolean}
   */
  isQuestion(body) {
    throw new Error('Adapter must implement isQuestion()');
  }

  /**
   * Parse a lifecycle event from the hook body.
   *
   * @param {object} body - Raw JSON body
   * @returns {{ event: string, sessionId: string, cwd?: string, source?: string, reason?: string }}
   */
  parseLifecycle(body) {
    return {
      event: body.event,
      sessionId: body.session_id,
      cwd: body.cwd,
      source: body.source,
      reason: body.reason,
    };
  }

  /**
   * Parse a notification from the hook body.
   *
   * @param {object} body - Raw JSON body
   * @returns {{ toolName: string, prompt: string, hookEvent: string }}
   */
  parseNotification(body) {
    throw new Error('Adapter must implement parseNotification()');
  }
}
