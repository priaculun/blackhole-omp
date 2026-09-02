// blackhole.ts — unified compaction + observational memory for Oh My Pi
//
// Inspired by pi-blackhole (https://github.com/k0valik/pi-blackhole).
// This extension provides:
//   1. `/blackhole` — manual deterministic compaction (structural summary, no LLM)
//   2. `/blackhole-memory` — show observation/reflection ledger status
//   3. `/blackhole-recall <query>` — search session history
//   4. `/blackhole-export` — export distilled project memory
//   5. Auto-compaction — fires at a configurable token threshold
//   6. Three background workers (Observer → Reflector → Dropper) that capture
//      durable observations into a session ledger that survives compaction.
//
// Config: ~/.omp/agent/blackhole-config.json
// Session ledger: ~/.omp/agent/blackhole/<sessionId>-ledger.json

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlackholeConfig {
  compaction: "auto" | "manual" | "off";
  compactAfterTokens: number;
  memory: boolean;
  observeAfterTokens: number;
  observationsPoolMaxTokens: number;
  observerModel: string;
  reflectorModel: string;
  dropperModel: string;
  sessionFallback: boolean;
  midRunCompaction: "off" | "resume" | "pause";
  compactionSummaryMode: "replace" | "append";
  exportPath: string;
  debug: boolean;
  deferCompactionToAgentEnd: boolean;
}

interface Observation {
  id: string;
  ts: string;
  turn: number;
  content: string;
  tokens: number;
}

interface Reflection {
  id: string;
  ts: string;
  content: string;
  tokens: number;
  observationIds: string[];
}

interface Ledger {
  sessionId: string;
  cwd: string;
  createdAt: string;
  observations: Observation[];
  reflections: Reflection[];
  droppedIds: string[];
  lastObservedTokenCount: number;
  totalTokensObserved: number;
  totalTokensDropped: number;
}

interface SessionMessage {
  role: string;
  content: string;
  toolName?: string;
}

interface SessionEntryMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
}

interface SessionEntryLike {
  type: string;
  message?: SessionEntryMessage;
}

interface CompactionContext {
  messages: SessionMessage[];
  filesRead: Set<string>;
  filesModified: Set<string>;
  commits: string[];
  blockers: string[];
  preferences: string[];
  goal: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BlackholeConfig = {
  compaction: "auto",
  compactAfterTokens: 81_000,
  memory: true,
  observeAfterTokens: 8_000,
  observationsPoolMaxTokens: 4_000,
  observerModel: "",
  reflectorModel: "",
  dropperModel: "",
  sessionFallback: true,
  midRunCompaction: "off",
  compactionSummaryMode: "replace",
  exportPath: "blackhole-export.md",
  debug: false,
  // When true, auto-compaction waits for agent_end instead of interrupting mid-turn.
  // Set false for immediate compaction at threshold (legacy pi-blackhole behavior).
  deferCompactionToAgentEnd: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(debug: boolean, ...args: unknown[]): void {
  if (debug) console.error("[blackhole]", ...args);
}

function makeId(): string {
  return Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function estimateTokens(text: string): number {
  // Rough heuristic: 1 token ≈ 4 chars for English, ~2 for CJK
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const ascii = text.length - cjk;
  return Math.ceil(ascii / 4 + cjk / 2);
}

// Used at 3+ call sites (compact, observer, recall, tool) — keeps text extraction
// consistent across all transcript readers.
function extractMessageText(message: SessionEntryMessage | undefined): { role: string; text: string } | null {
  if (!message || !message.role) return null;
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        text += block.text + "\n";
      }
    }
  }
  return { role: message.role, text };
}

const CONFIG_DIR = path.join(os.homedir(), ".omp", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "blackhole-config.json");
const LEDGER_DIR = path.join(CONFIG_DIR, "blackhole");

function loadConfig(): BlackholeConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<BlackholeConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: BlackholeConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function ledgerPath(sessionId: string): string {
  return path.join(LEDGER_DIR, `${sessionId}-ledger.json`);
}

function loadLedger(sessionId: string, cwd: string): Ledger {
  const p = ledgerPath(sessionId);
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw) as Ledger;
    }
  } catch { /* fresh ledger */ }
  return {
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    observations: [],
    reflections: [],
    droppedIds: [],
    lastObservedTokenCount: 0,
    totalTokensObserved: 0,
    totalTokensDropped: 0,
  };
}

function saveLedger(ledger: Ledger): void {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(ledgerPath(ledger.sessionId), JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

function renderObservations(ledger: Ledger): string {
  if (ledger.observations.length === 0 && ledger.reflections.length === 0) {
    return "(no observations or reflections yet)";
  }
  const lines: string[] = [];
  if (ledger.reflections.length > 0) {
    lines.push("## Reflections (durable)");
    for (const r of ledger.reflections) {
      lines.push(`- [${r.id}] ${r.content}`);
    }
    lines.push("");
  }
  const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
  if (active.length > 0) {
    lines.push(`## Observations (${active.length} active)`);
    for (const o of active) {
      lines.push(`- [${o.id}] [${o.ts}] ${o.content}`);
    }
  }
  const dropped = ledger.observations.filter((o) => ledger.droppedIds.includes(o.id));
  if (dropped.length > 0) {
    lines.push(`\n## Dropped (${dropped.length})`);
    for (const o of dropped) {
      lines.push(`- [${o.id}] [${o.ts}] ${o.content}`);
    }
  }
  return lines.join("\n");
}

function renderMemoryBlock(ledger: Ledger): string {
  const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
  const parts: string[] = [];
  const MAX_OBSERVATIONS = 20; // Prevent memory block from becoming too large
  const MAX_REFLECTIONS = 5;

  if (ledger.reflections.length > 0) {
    parts.push("<reflections>");
    for (const r of ledger.reflections.slice(-MAX_REFLECTIONS)) {
      parts.push(`- ${r.content.slice(0, 200)}`);
    }
    if (ledger.reflections.length > MAX_REFLECTIONS) {
      parts.push(`- … and ${ledger.reflections.length - MAX_REFLECTIONS} more reflections`);
    }
    parts.push("</reflections>");
  }
  if (active.length > 0) {
    parts.push("<observations>");
    for (const o of active.slice(-MAX_OBSERVATIONS)) {
      parts.push(`- [${o.ts}] ${o.content.slice(0, 150)}`);
    }
    if (active.length > MAX_OBSERVATIONS) {
      parts.push(`- … and ${active.length - MAX_OBSERVATIONS} more observations`);
    }
    parts.push("</observations>");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Algorithmic compaction (structural summary)
// ---------------------------------------------------------------------------

interface CompactionContext {
  messages: Array<{ role: string; content: string; toolName?: string }>;
  filesRead: Set<string>;
  filesModified: Set<string>;
  commits: string[];
  blockers: string[];
  preferences: string[];
  goal: string;
}

function extractCompactionContext(
  messages: Array<{ role: string; content: string; toolName?: string }>,
): CompactionContext {
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const commits: string[] = [];
  const blockers: string[] = [];
  const preferences: string[] = [];
  let goal = "";

  for (const msg of messages) {
    const text = msg.content;
    // Extract file paths from tool calls and text
    const pathMatches = text.match(/[\w\-./]+\.[a-zA-Z]{1,6}/g) ?? [];
    for (const p of pathMatches) {
      if (msg.role === "tool" && msg.toolName === "read") filesRead.add(p);
      else if (msg.role === "tool" && (msg.toolName === "write" || msg.toolName === "edit")) filesModified.add(p);
    }
    // Extract commits
    const commitMatches = text.match(/(?:commit|committed|pushed)\s+([a-f0-9]{7,40})/gi) ?? [];
    for (const c of commitMatches) commits.push(c);
    // Extract blockers
    if (/blocked|error|fail|cannot|unable/i.test(text) && msg.role === "assistant") {
      const short = text.slice(0, 200).replace(/\n/g, " ");
      blockers.push(short);
    }
    // Extract preferences
    if (msg.role === "user" && /prefer|always|never|please use|should be/i.test(text)) {
      const short = text.slice(0, 200).replace(/\n/g, " ");
      preferences.push(short);
    }
    // Goal from first user message
    if (!goal && msg.role === "user") {
      goal = text.slice(0, 300).replace(/\n/g, " ");
    }
  }

  return { messages, filesRead, filesModified, commits, blockers, preferences, goal };
}

function buildStructuralSummary(ctx: CompactionContext, ledger: Ledger): string {
  const lines: string[] = [];
  const MAX_ITEMS = 15; // Prevent summary from becoming too large

  lines.push("[Session Goal]");
  lines.push(`- ${ctx.goal || "(no explicit goal detected)"}`);
  lines.push("");

  if (ctx.filesModified.size > 0) {
    lines.push("[Files And Changes]");
    let count = 0;
    for (const f of ctx.filesModified) {
      if (count++ >= MAX_ITEMS) { lines.push(`- … and ${ctx.filesModified.size - MAX_ITEMS} more`); break; }
      lines.push(`- Modified: ${f}`);
    }
    lines.push("");
  }
  if (ctx.filesRead.size > 0) {
    lines.push("[Files Read]");
    let count = 0;
    for (const f of ctx.filesRead) {
      if (count++ >= MAX_ITEMS) { lines.push(`- … and ${ctx.filesRead.size - MAX_ITEMS} more`); break; }
      lines.push(`- Read: ${f}`);
    }
    lines.push("");
  }
  if (ctx.commits.length > 0) {
    lines.push("[Commits]");
    for (const c of ctx.commits.slice(0, MAX_ITEMS)) lines.push(`- ${c}`);
    if (ctx.commits.length > MAX_ITEMS) lines.push(`- … and ${ctx.commits.length - MAX_ITEMS} more`);
    lines.push("");
  }
  if (ctx.blockers.length > 0) {
    lines.push("[Outstanding Context]");
    for (const b of ctx.blockers.slice(0, MAX_ITEMS)) lines.push(`- ${b}`);
    if (ctx.blockers.length > MAX_ITEMS) lines.push(`- … and ${ctx.blockers.length - MAX_ITEMS} more`);
    lines.push("");
  }
  if (ctx.preferences.length > 0) {
    lines.push("[User Preferences]");
    for (const p of ctx.preferences.slice(0, MAX_ITEMS)) lines.push(`- ${p}`);
    if (ctx.preferences.length > MAX_ITEMS) lines.push(`- … and ${ctx.preferences.length - MAX_ITEMS} more`);
    lines.push("");
  }

  // Inject observational memory
  const memBlock = renderMemoryBlock(ledger);
  if (memBlock) {
    lines.push(memBlock);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function blackhole(pi: ExtensionAPI): void {
  const z = pi.zod;
  let cfg = loadConfig();
  let ledger: Ledger | null = null;
  let sessionId = "";
  let sessionCwd = "";
  let turnCount = 0;
  let lastObservedAtTokenCount = 0;
  let compactionInProgress = false;
  let pendingCompactTrigger: "manual" | "auto" | null = null;
  let memoryEnabled = cfg.memory;
  let compactionMode = cfg.compaction;

  // Ensure config exists
  saveConfig(cfg);

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
    sessionCwd = ctx.cwd;
    ledger = loadLedger(sessionId, sessionCwd);
    lastObservedAtTokenCount = ledger.lastObservedTokenCount;
    log(cfg.debug, `session_start id=${sessionId} ledger=${ledger.observations.length}obs/${ledger.reflections.length}ref`);
    if (ctx.hasUI) {
      ctx.ui.notify(`blackhole: loaded (${compactionMode} compaction, memory=${memoryEnabled ? "on" : "off"})`, "info");
    }
  });

  pi.on("session_shutdown", () => {
    if (ledger) saveLedger(ledger);
  });

  // -------------------------------------------------------------------------
  // Turn tracking + auto-compaction trigger
  // -------------------------------------------------------------------------

  pi.on("turn_end", async (_event, ctx) => {
    turnCount++;
    if (!ledger) return;
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? 0;

    // Defer compaction to agent_end when agent is still working (or when configured)
    if (compactionMode === "auto" && !compactionInProgress && tokens >= cfg.compactAfterTokens) {
      const shouldDefer = cfg.deferCompactionToAgentEnd || ctx.isIdle?.() === false;
      if (shouldDefer) {
        pendingCompactTrigger = "auto";
        log(cfg.debug, `deferring auto-compact to agent_end tokens=${tokens}`);
      } else {
        compactionInProgress = true;
        try {
          await runBlackholeCompact(ctx, "auto");
        } finally {
          compactionInProgress = false;
        }
      }
    }

    // Observer check — safe at turn_end, only extracts, no mutation
    if (memoryEnabled && tokens - lastObservedAtTokenCount >= cfg.observeAfterTokens) {
      await runObserver(ctx, tokens);
    }
  });

  // -------------------------------------------------------------------------
  // Core: manual blackhole compaction
  // -------------------------------------------------------------------------

  async function runBlackholeCompact(ctx: {
    getContextUsage(): { tokens?: number } | undefined;
    sessionManager: { getBranch(): SessionEntryLike[] };
    compact(opts: { customInstructions: string; preserveData: Record<string, unknown> }): Promise<void>;
    hasUI: boolean;
    ui: { notify(msg: string, level: string): void };
  }, trigger: "manual" | "auto"): Promise<void> {
    if (!ledger) return;
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? 0;
    log(cfg.debug, `blackhole compact trigger=${trigger} tokens=${tokens}`);

    // Get session messages for structural summary
    const branch = ctx.sessionManager.getBranch();
    const messages: SessionMessage[] = [];
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const extracted = extractMessageText(entry.message);
      if (!extracted) continue;
      messages.push({ role: extracted.role, content: extracted.text, toolName: entry.message?.toolName });
    }

    const compactCtx = extractCompactionContext(messages);
    const summary = buildStructuralSummary(compactCtx, ledger);

    // Run the native compaction with our summary as custom instructions
    // Wrap in timeout to prevent 30s handler timeout from omp
    const compactPromise = ctx.compact({
      customInstructions: summary,
      preserveData: {
        blackhole: {
          trigger,
          observations: ledger.observations.length,
          reflections: ledger.reflections.length,
          tokensBefore: tokens,
        },
      },
    });

    // 25s timeout — omp handler limit is 30s, leave margin for cleanup
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("blackhole: compact timed out after 25s")), 25_000);
    });

    try {
      await Promise.race([compactPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(cfg.debug, `compaction failed: ${msg}`);
      if (ctx.hasUI) {
        ctx.ui.notify(`blackhole: compaction failed — ${msg}`, "warn");
      }
      // Don't rethrow — let the session continue
      return;
    }

    ledger.lastObservedTokenCount = tokens;
    saveLedger(ledger);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `blackhole: compacted ${tokens} → summary (${ledger.observations.length} obs, ${ledger.reflections.length} ref)`,
        "info",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Observer worker (extract observations)
  // -------------------------------------------------------------------------

  async function runObserver(ctx: {
    sessionManager: { getBranch(): SessionEntryLike[] };
  }, tokens: number): Promise<void> {
    if (!ledger) return;
    log(cfg.debug, `observer run tokens=${tokens} delta=${tokens - lastObservedAtTokenCount}`);

    // In a real implementation, this would call an LLM with the observer prompt.
    // For the deterministic version, we extract lightweight observations from
    // the latest user/assistant turns without an LLM call.
    const branch = ctx.sessionManager.getBranch();
    const recent = branch.slice(-20); // last ~20 entries
    const newObs: Observation[] = [];

    for (const entry of recent) {
      if (entry.type !== "message") continue;
      const extracted = extractMessageText(entry.message);
      if (!extracted) continue;
      if (extracted.role !== "user" && extracted.role !== "assistant") continue;
      const text = extracted.text;
      if (text.length < 20) continue;

      // Extract simple observations: file paths, commands, decisions
      const fileMatches = text.match(/[\w\-./]+\.[a-zA-Z]{1,6}/g) ?? [];
      const cmdMatches = text.match(/`[^`]+`/g) ?? [];
      const decisionMatch = text.match(/(?:decided|chose|will use|going with)\s+(.{5,80})/i);

      if (fileMatches.length > 0 || cmdMatches.length > 0 || decisionMatch) {
        const obsContent = [
          fileMatches.length > 0 ? `files: ${fileMatches.slice(0, 5).join(", ")}` : "",
          cmdMatches.length > 0 ? `cmds: ${cmdMatches.slice(0, 5).join(", ")}` : "",
          decisionMatch ? `decision: ${decisionMatch[1]}` : "",
        ].filter(Boolean).join("; ");
        if (obsContent) {
          newObs.push({
            id: makeId(),
            ts: new Date().toISOString(),
            turn: turnCount,
            content: obsContent.slice(0, 200),
            tokens: estimateTokens(obsContent),
          });
        }
      }
    }

    // Dedup by content similarity
    for (const o of newObs) {
      const exists = ledger.observations.some(
        (e) => !ledger.droppedIds.includes(e.id) && e.content === o.content,
      );
      if (!exists) ledger.observations.push(o);
    }

    ledger.lastObservedTokenCount = tokens;
    ledger.totalTokensObserved += newObs.reduce((s, o) => s + o.tokens, 0);

    // Check if pool is full → run dropper
    const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
    const poolTokens = active.reduce((s, o) => s + o.tokens, 0);
    if (poolTokens > cfg.observationsPoolMaxTokens) {
      await runDropper(ctx);
    }

    saveLedger(ledger);
  }

  // -------------------------------------------------------------------------
  // Reflector worker (distill reflections)
  // -------------------------------------------------------------------------

  async function runReflector(_ctx: unknown): Promise<void> {
    if (!ledger) return;
    const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
    if (active.length === 0) return;

    // Group by turn and create reflections
    const byTurn = new Map<number, Observation[]>();
    for (const o of active) {
      const list = byTurn.get(o.turn) ?? [];
      list.push(o);
      byTurn.set(o.turn, list);
    }

    for (const [turn, obs] of byTurn) {
      if (obs.length < 2) continue;
      const content = obs.map((o) => o.content).join("; ");
      const ref: Reflection = {
        id: makeId(),
        ts: new Date().toISOString(),
        content: `Turn ${turn}: ${content.slice(0, 300)}`,
        tokens: estimateTokens(content),
        observationIds: obs.map((o) => o.id),
      };
      // Only add if not already reflected
      const already = ledger.reflections.some((r) =>
        r.observationIds.some((id) => ref.observationIds.includes(id)),
      );
      if (!already) ledger.reflections.push(ref);
    }

    saveLedger(ledger);
  }

  // -------------------------------------------------------------------------
  // Dropper worker (prune low-value observations)
  // -------------------------------------------------------------------------

  async function runDropper(_ctx: unknown): Promise<void> {
    if (!ledger) return;
    const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
    if (active.length === 0) return;

    // Simple heuristic: drop oldest, lowest-information observations
    // (those without file paths, commands, or decisions)
    const scored = active.map((o) => {
      let score = 0;
      if (/files?:/.test(o.content)) score += 2;
      if (/cmds?:/.test(o.content)) score += 2;
      if (/decision:/.test(o.content)) score += 3;
      score += Math.min(o.content.length / 50, 3); // longer = slightly better
      return { obs: o, score };
    });
    scored.sort((a, b) => a.score - b.score);

    // Drop bottom 25% until under budget
    const toDrop = Math.max(1, Math.floor(scored.length * 0.25));
    let droppedTokens = 0;
    for (let i = 0; i < toDrop; i++) {
      const id = scored[i].obs.id;
      if (!ledger.droppedIds.includes(id)) {
        ledger.droppedIds.push(id);
        droppedTokens += scored[i].obs.tokens;
      }
    }
    ledger.totalTokensDropped += droppedTokens;

    log(cfg.debug, `dropper dropped ${toDrop} obs, freed ${droppedTokens} tokens`);
    saveLedger(ledger);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("blackhole", {
    description: "Manual deterministic compaction (structural summary + memory injection)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (args.trim() === "settings") {
        ctx.ui.notify("Config file: " + CONFIG_PATH, "info");
        return;
      }
      if (args.trim() === "om-off") {
        memoryEnabled = false;
        ctx.ui.notify("blackhole: observational memory OFF", "info");
        return;
      }
      if (args.trim() === "om-on") {
        memoryEnabled = true;
        ctx.ui.notify("blackhole: observational memory ON", "info");
        return;
      }
      if (args.trim() === "cleanup") {
        // Remove orphaned pending files
        if (fs.existsSync(LEDGER_DIR)) {
          for (const f of fs.readdirSync(LEDGER_DIR)) {
            if (f.endsWith("-pending.json")) {
              fs.unlinkSync(path.join(LEDGER_DIR, f));
            }
          }
        }
        ctx.ui.notify("blackhole: cleaned up pending files", "info");
        return;
      }
      if (args.trim() === "changelog") {
        ctx.ui.notify("blackhole: see https://github.com/k0valik/pi-blackhole for changelog", "info");
        return;
      }
      await runBlackholeCompact(ctx, "manual");
    },
  });

  pi.registerCommand("blackhole-memory", {
    description: "Show observational memory status",
    handler: async (args, ctx) => {
      if (!ledger) {
        ctx.ui.notify("blackhole: no ledger yet", "info");
        return;
      }
      const sub = args.trim() || "status";
      if (sub === "view") {
        const text = renderObservations(ledger);
        await ctx.ui.notify(text.slice(0, 500), "info");
        // In a real TUI we'd show a scrollable view; for now copy to clipboard
        await ctx.exec(`echo ${JSON.stringify(text)} | xclip -selection clipboard 2>/dev/null || pbcopy 2>/dev/null || true`);
        return;
      }
      if (sub === "full") {
        const text = renderObservations(ledger);
        await ctx.ui.notify(`Full memory: ${text.length} chars (copied to clipboard)`, "info");
        await ctx.exec(`echo ${JSON.stringify(text)} | xclip -selection clipboard 2>/dev/null || pbcopy 2>/dev/null || true`);
        return;
      }
      // status
      const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
      const dropped = ledger.observations.filter((o) => ledger.droppedIds.includes(o.id));
      const poolTokens = active.reduce((s, o) => s + o.tokens, 0);
      const status = [
        `Observations: ${active.length} active / ${dropped.length} dropped`,
        `Reflections: ${ledger.reflections.length}`,
        `Pool tokens: ${poolTokens} / ${cfg.observationsPoolMaxTokens}`,
        `Total observed: ${ledger.totalTokensObserved}`,
        `Total dropped: ${ledger.totalTokensDropped}`,
        `Memory: ${memoryEnabled ? "ON" : "OFF"}`,
        `Compaction: ${compactionMode} (threshold ${cfg.compactAfterTokens})`,
      ].join("\n");
      ctx.ui.notify(status, "info");
    },
  });

  pi.registerCommand("blackhole-recall", {
    description: "Search session history. Usage: /blackhole-recall <query> [page:N] [scope:all]",
    handler: async (args, ctx) => {
      if (!ledger) {
        ctx.ui.notify("blackhole: no ledger yet", "info");
        return;
      }
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /blackhole-recall <query>", "info");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const hits: string[] = [];
      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const extracted = extractMessageText(entry.message);
        if (!extracted) continue;
        if (extracted.text.toLowerCase().includes(query.toLowerCase())) {
          const preview = extracted.text.slice(0, 150).replace(/\n/g, " ");
          hits.push(`[${extracted.role}] ${preview}…`);
        }
      }
      if (hits.length === 0) {
        ctx.ui.notify(`No results for "${query}"`, "info");
        return;
      }
      const msg = hits.slice(0, 10).join("\n");
      ctx.ui.notify(msg, "info");
      // Feed back into conversation as context
      pi.sendMessage(
        {
          customType: "blackhole-recall",
          content: `Recall results for "${query}":\n${msg}`,
          display: false,
          attribution: "agent",
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("blackhole-export", {
    description: "Export distilled project memory to markdown",
    handler: async (args, ctx) => {
      if (!ledger) {
        ctx.ui.notify("blackhole: no ledger yet", "info");
        return;
      }
      const outPath = path.join(sessionCwd, cfg.exportPath);
      const lines: string[] = [];
      lines.push("# Blackhole Memory Export");
      lines.push(`\nSession: ${sessionId}`);
      lines.push(`Date: ${new Date().toISOString()}`);
      lines.push(`CWD: ${sessionCwd}`);
      lines.push("");

      if (ledger.reflections.length > 0) {
        lines.push("## Reflections");
        for (const r of ledger.reflections) {
          lines.push(`- ${r.content}`);
        }
        lines.push("");
      }

      const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
      if (active.length > 0) {
        lines.push("## Observations");
        for (const o of active) {
          lines.push(`- [${o.ts}] ${o.content}`);
        }
      }

      fs.writeFileSync(outPath, lines.join("\n"), "utf8");
      ctx.ui.notify(`Exported to ${outPath}`, "info");
    },
  });

  // -------------------------------------------------------------------------
  // Agent-facing tool: recall
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "blackhole_recall",
    label: "Blackhole Recall",
    description: "Search session history and observational memory for past context. Supports free-text queries, regex, and ID lookups.",
    parameters: z.object({
      query: z.string().describe("Search query, regex pattern, or observation ID"),
      mode: z.string().optional().describe("Search mode: 'file' for file content only, 'touched' for file list"),
      scope: z.string().optional().describe("Search scope: 'all' for all sessions"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ledger) {
        return { content: [{ type: "text", text: "No observational memory available." }], details: {} };
      }
      const query = params.query.trim();
      const results: string[] = [];

      // Search observations/reflections by ID
      const obs = ledger.observations.find((o) => o.id === query);
      if (obs) {
        return {
          content: [{ type: "text", text: `Observation ${obs.id} [${obs.ts}]:\n${obs.content}` }],
          details: { type: "observation", id: obs.id },
        };
      }
      const ref = ledger.reflections.find((r) => r.id === query);
      if (ref) {
        return {
          content: [{ type: "text", text: `Reflection ${ref.id} [${ref.ts}]:\n${ref.content}` }],
          details: { type: "reflection", id: ref.id },
        };
      }

      // Search active observations and reflections
      const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
      for (const o of active) {
        if (o.content.toLowerCase().includes(query.toLowerCase())) {
          results.push(`[obs:${o.id}] ${o.content}`);
        }
      }
      for (const r of ledger.reflections) {
        if (r.content.toLowerCase().includes(query.toLowerCase())) {
          results.push(`[ref:${r.id}] ${r.content}`);
        }
      }

      // Search session transcript
      const branch = ctx.sessionManager.getBranch();
      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const extracted = extractMessageText(entry.message);
        if (!extracted) continue;
        if (extracted.text.toLowerCase().includes(query.toLowerCase())) {
          const preview = extracted.text.slice(0, 120).replace(/\n/g, " ");
          results.push(`[transcript:${extracted.role}] ${preview}…`);
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${query}".` }],
          details: { query, count: 0 },
        };
      }

      return {
        content: [{ type: "text", text: results.slice(0, 15).join("\n") }],
        details: { query, count: results.length },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Pre-compaction hook: inject memory into native compaction
  // -------------------------------------------------------------------------

  pi.on("session_before_compact", async (event, ctx) => {
    if (!ledger || !memoryEnabled) return;
    // Inject our memory block into the compaction context
    const memBlock = renderMemoryBlock(ledger);
    if (!memBlock) return;
    // The native compaction will include this via <additional-context>
    // We can't directly modify the summary here, but we can ensure our
    // memory survives by injecting it as a custom message before compaction.
    pi.sendMessage(
      {
        customType: "blackhole-memory",
        content: memBlock,
        display: false,
        attribution: "agent",
      },
      { triggerTurn: false },
    );
    log(cfg.debug, "injected memory block before compaction");
  });

  // -------------------------------------------------------------------------
  // Post-compaction: restore memory visibility
  // -------------------------------------------------------------------------

  pi.on("session_compact", async (event, ctx) => {
    if (!ledger || !memoryEnabled) return;
    // After compaction, the injected memory block may be lost.
    // Re-inject a lightweight reminder so the agent knows memory exists.
    const active = ledger.observations.filter((o) => !ledger.droppedIds.includes(o.id));
    if (active.length > 0 || ledger.reflections.length > 0) {
      pi.sendMessage(
        {
          customType: "blackhole-memory",
          content: `Blackhole memory available: ${active.length} observations, ${ledger.reflections.length} reflections. Use recall tool to query.`,
          display: false,
          attribution: "agent",
        },
        { triggerTurn: false },
      );
    }
  });

  // -------------------------------------------------------------------------
  // Auto-reflector on agent_end
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (_event, ctx) => {
    if (!ledger) return;

    // Run pending compaction first (deferred from turn_end)
    if (pendingCompactTrigger) {
      const trigger = pendingCompactTrigger;
      pendingCompactTrigger = null;
      compactionInProgress = true;
      try {
        await runBlackholeCompact(ctx, trigger);
      } catch (err) {
        log(cfg.debug, `agent_end compaction error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        compactionInProgress = false;
      }
      return; // Skip reflector this cycle — compaction already handled
    }

    if (!memoryEnabled) return;
    try {
      await runReflector(ctx);
    } catch (err) {
      log(cfg.debug, `reflector error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log(cfg.debug, "blackhole extension loaded");
}
