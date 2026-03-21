/**
 * compact-context.js — Generates a compact sprint context summary
 * for re-injection after Claude Code session compaction.
 *
 * Reads compilation.json from a project directory (never claims.json directly).
 * Output: ~2000 tokens max plain text summary.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Tool descriptions for the ecosystem summary block.
const TOOL_DESCRIPTIONS = {
  farmer: "session management + mobile dashboard",
  wheat: "research sprint framework",
  barn: "shared tools + templates",
  mill: "file conversion + export",
  silo: "knowledge packs",
  harvest: "decay tracking + analytics",
  orchard: "workflow orchestration",
  grainulation: "meta-package + PM",
};

/**
 * Build a compact context summary from a project's compilation.json.
 *
 * @param {string} cwd — Project root directory
 * @param {Object} [ecosystemPorts] — Port registry { name: port }
 * @returns {{ text: string, hash: string, timestamp: string, compilationHash: string|null, stale: boolean } | null}
 */
export function buildCompactContext(cwd, ecosystemPorts) {
  if (!cwd) return null;
  const compilationPath = join(cwd, "compilation.json");
  const now = new Date().toISOString();

  if (!existsSync(compilationPath)) {
    return buildMinimalContext(cwd, now);
  }

  let compilation;
  try {
    compilation = JSON.parse(readFileSync(compilationPath, "utf8"));
  } catch {
    return buildMinimalContext(cwd, now);
  }

  const meta = compilation.sprint_meta || {};
  const phase = compilation.phase_summary || {};
  const coverage = compilation.coverage || {};
  const cert = compilation.compilation_certificate || {};

  const topics = Object.keys(coverage);
  const blockerTopics = topics.filter((t) => coverage[t].status === "blocked");
  const weakTopics = topics.filter((t) => coverage[t].status === "weak");

  // Top constraints from resolved claims
  const constraints = (compilation.resolved_claims || [])
    .filter((c) => c.type === "constraint" && c.status === "active")
    .slice(0, 5)
    .map((c) => `- ${c.content.slice(0, 120)}`);

  // Unresolved conflicts
  const conflictGraph = compilation.conflict_graph || {};
  const unresolvedConflicts = Array.isArray(conflictGraph.unresolved)
    ? conflictGraph.unresolved
    : [];

  const lines = [
    `== SPRINT CONTEXT (re-injected after compaction) ==`,
    `Generated: ${now}`,
    `Compilation: ${compilation.compiled_at} (hash: ${compilation.claims_hash})`,
    ``,
    `QUESTION: ${meta.question || "Not set"}`,
    `Phase: ${meta.phase || "unknown"} | Claims: ${meta.total_claims || 0} total, ${meta.active_claims || 0} active, ${meta.conflicted_claims || 0} conflicted`,
    ``,
    `PHASE PROGRESS:`,
  ];

  for (const [name, info] of Object.entries(phase)) {
    lines.push(
      `  ${name}: ${info.claims} claims${info.complete ? " [complete]" : ""}`,
    );
  }

  lines.push("");
  lines.push(
    `COVERAGE: ${topics.length} topics | ${blockerTopics.length} blocked | ${weakTopics.length} weak`,
  );

  if (blockerTopics.length > 0) {
    lines.push(`BLOCKERS: ${blockerTopics.join(", ")}`);
  }

  if (unresolvedConflicts.length > 0) {
    lines.push(`UNRESOLVED CONFLICTS: ${unresolvedConflicts.length}`);
    for (const c of unresolvedConflicts.slice(0, 3)) {
      lines.push(
        `  - ${c.claim_a} vs ${c.claim_b}: ${c.reason || "no reason"}`,
      );
    }
  }

  if (constraints.length > 0) {
    lines.push("");
    lines.push("TOP CONSTRAINTS:");
    lines.push(...constraints);
  }

  // Ecosystem summary (only if port registry provided)
  if (ecosystemPorts && Object.keys(ecosystemPorts).length > 0) {
    lines.push("");
    lines.push(`ECOSYSTEM (${Object.keys(ecosystemPorts).length} tools):`);
    for (const [name, port] of Object.entries(ecosystemPorts)) {
      const desc = TOOL_DESCRIPTIONS[name] || "";
      lines.push(`  ${name.padEnd(14)} :${port}  ${desc}`);
    }
  }

  lines.push("");
  lines.push(
    `Compilation status: ${compilation.status} | Errors: ${(compilation.errors || []).length} | Warnings: ${(compilation.warnings || []).length}`,
  );
  lines.push(`== END SPRINT CONTEXT ==`);

  const text = lines.join("\n");
  const contextHash = createHash("md5").update(text).digest("hex").slice(0, 8);

  return {
    text,
    hash: contextHash,
    timestamp: now,
    compilationHash: compilation.claims_hash,
    stale: false,
  };
}

function buildMinimalContext(cwd, now) {
  // Check if there's at least a claims.json with a meta.question
  const claimsPath = join(cwd, "claims.json");
  let question = null;
  try {
    if (existsSync(claimsPath)) {
      const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
      question = claims.meta?.question;
    }
  } catch {}

  if (!question) return null; // No sprint data at all — nothing to inject

  const text = [
    `== SPRINT CONTEXT (minimal -- compilation.json not found) ==`,
    `Generated: ${now}`,
    `QUESTION: ${question}`,
    `Run the wheat compiler to rebuild compilation.`,
    `== END SPRINT CONTEXT ==`,
  ].join("\n");

  return {
    text,
    hash: "minimal",
    timestamp: now,
    compilationHash: null,
    stale: true,
  };
}
