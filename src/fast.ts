// The fast path: one streamed call that reads every reply at once and writes the
// ranked rules directly. Sonnet at low effort answers without thinking, so the
// first rule shows up within a few seconds and the rest stream in behind it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "./types.ts";
import type { StoredRule } from "./store.ts";
import { STATE_DIR } from "./paths.ts";
import { redact, truncate } from "./clean.ts";

const BASE = `You read every reply a developer sent to their AI coding agents. Each line has an id, the [repo], what the agent had just done, and the developer's reply.
Find the corrections and preferences the developer keeps repeating, and write the rules that would stop the agent making those mistakes.
Output ONLY lines in these two formats, nothing else:
RULE | <scope> | <rule> | <count> | <ids>
SEEN | <applied rule id> | <ids>

RULE lines, best first, at most {MAX}:{FOCUS}
- <scope> is "global" or one repo name exactly as it appears in the lines.
- <rule> is ONE instruction to the agent, at most 16 words, specific to this developer (the tools, places, names and habits they mention). Never generic advice any agent already follows.
- SAVED RULES were suggested on earlier runs; keep the list stable. If a saved rule (in your topic) is still among the strongest, write its id (like r:1a2b3c4d) as <rule> instead of rewriting it, and only leave it out for something clearly stronger.
- <count> is roughly how many replies show it (a number).
- <ids> are 2 to 4 reply ids that show it, comma-separated. Only rules backed by 2+ replies from different moments; skip one-off task instructions.
- Never suggest anything already covered by EXISTING INSTRUCTIONS, APPLIED RULES or DISMISSED.
{SEEN}`;

const SEEN_RULE = "After the RULE lines, write one SEEN line per APPLIED rule with the ids of replies that correct that same mistake (skip it if there are none).";

export function systemFor(max: number, focus = "", seen = true): string {
  return BASE.replace("{MAX}", String(max))
    .replace("{FOCUS}", focus ? `\n- Only rules about ${focus}.` : "")
    .replace("{SEEN}", seen ? SEEN_RULE : "Write no SEEN lines.");
}

/** Two parallel streams split by topic, so each writes half the rules (and they rarely overlap). */
export const FOCUS = [
  "how the developer wants the agent to work: autonomy, research, verification, communication, git and process",
  "the product and code itself: UI and design, copy and tone, data and domain facts, architecture and repo conventions",
];

/** Single-call version for agents that can't stream. */
export const FAST_SYSTEM = systemFor(6);

/** One reply per line: id, repo, what the agent did, what the developer said. */
export function replyLines(cands: Candidate[], offset = 0): string {
  return cands
    .map((c, i) => `m${i + offset} [${c.repo}] agent: ${truncate(c.agentAction.replace(/^(tools|said) → /gm, ""), 50)} || dev: ${truncate(c.userText, 130)}`)
    .join("\n");
}

export function fastPrompt(o: { cands: Candidate[]; existing: string; saved: StoredRule[]; applied: StoredRule[]; dismissed: StoredRule[]; recent?: number }): string {
  // Ids stay global (m<index into cands>) even when only the most recent replies are sent.
  const from = o.recent ? Math.max(0, o.cands.length - o.recent) : 0;
  const list = (rs: StoredRule[]) => rs.map((r) => `r:${r.id} (${r.scope === "repo" ? r.repo : "global"}) ${r.text}`).join("\n") || "(none)";
  // Replies first: they only grow at the end, so repeat runs share a long cached prefix.
  return [
    `REPLIES\n${replyLines(o.cands.slice(from), from)}`,
    `EXISTING INSTRUCTIONS\n${o.existing || "(none)"}`,
    `SAVED RULES\n${list(o.saved)}`,
    `APPLIED RULES\n${list(o.applied)}`,
    `DISMISSED\n${list(o.dismissed)}`,
  ].join("\n\n");
}

export type FastLine = { kind: "rule"; scope: string; rule: string; ids: number[]; count?: number } | { kind: "seen"; id: string; ids: number[] };

export function parseLine(line: string): FastLine | undefined {
  const parts = line.split("|").map((x) => x.trim());
  const ids = (s: string | undefined) =>
    (s ?? "")
      .split(/[\s,]+/)
      .map((x) => Number(x.replace(/^m/, "")))
      .filter((n) => Number.isInteger(n) && n >= 0);
  if (parts[0] === "RULE" && parts.length >= 5 && parts[2] && /^\d+$/.test(parts[3])) return { kind: "rule", scope: parts[1], rule: parts[2], count: Number(parts[3]), ids: ids(parts[4]) };
  if (parts[0] === "RULE" && parts.length >= 4 && parts[2]) return { kind: "rule", scope: parts[1], rule: parts[2], ids: ids(parts[3]) };
  if (parts[0] === "SEEN" && parts.length >= 3) return { kind: "seen", id: parts[1].replace(/^r:/, ""), ids: ids(parts[2]) };
  return undefined;
}

/** Codex has a ~7 s floor per call and throttles parallel calls: one call over the most recent replies. */
export const CODEX_RECENT = 250;

export interface Stream {
  /** Only send the most recent N replies (slow agents). */
  recent?: number;
  /** Sends the prompt and calls onLine for every complete line as it arrives. */
  run(prompt: string, onLine: (line: string) => void): Promise<string>;
}

/**
 * Starts `claude` right away (its ~2 s startup overlaps with reading sessions)
 * and streams text deltas once the prompt is written.
 */
export function startClaudeStream(system: string, model = "sonnet"): Stream {
  const lean = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? ["--bare"] : ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
  const child = spawn(
    "claude",
    ["-p", ...lean, "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", model, "--effort", "low", "--system-prompt", redact(system), "--tools", ""],
    { cwd: STATE_DIR, stdio: ["pipe", "pipe", "pipe"] },
  );
  let raw = "";
  let text = "";
  let pending = "";
  let error = "";
  let emit: (line: string) => void = () => {};
  const flush = (all: boolean) => {
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      emit(pending.slice(0, i));
      pending = pending.slice(i + 1);
    }
    if (all && pending) {
      emit(pending);
      pending = "";
    }
  };
  child.stdout.on("data", (d) => {
    raw += d;
    let i;
    while ((i = raw.indexOf("\n")) >= 0) {
      const line = raw.slice(0, i);
      raw = raw.slice(i + 1);
      try {
        const ev = JSON.parse(line);
        const delta = ev.event?.delta?.text;
        if (ev.type === "stream_event" && typeof delta === "string") {
          text += delta;
          pending += delta;
          flush(false);
        }
        if (ev.type === "result" && ev.is_error) error = String(ev.result ?? "error");
      } catch {}
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.on("error", (e) => (error = String(e.message)));
  // If claude exits before reading the prompt, report its error instead of crashing on EPIPE.
  child.stdin.on("error", () => {});
  return {
    async run(prompt, onLine) {
      emit = onLine;
      child.stdin.end(redact(prompt));
      await closed;
      flush(true);
      if (error || (!text && stderr)) throw new Error(error || stderr.slice(-300));
      return text;
    },
  };
}

/** True when two rules say mostly the same thing (shared significant words). */
export function similar(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const overlap = (x: Set<string>, y: Set<string>) => [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size));
  // Same opening ("Keep UI minimal and compact…") means the same rule, whatever follows.
  const lead = (s: string) => words(s.split(/[;:,—]/)[0]);
  return overlap(words(a), words(b)) >= 0.5 || overlap(lead(a), lead(b)) >= 0.8;
}

/** Codex's fastest model this account can use (from Codex's own model list), plus the lightest reasoning it takes. */
export function pickCodexModel(): { model?: string; effort: string } {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"));
    const slugs: string[] = (raw.models ?? raw ?? []).map((m: any) => m.slug).filter(Boolean);
    const fast = slugs.find((s) => /luna/.test(s)) ?? slugs.find((s) => /terra|astra|mini|flash/.test(s));
    if (fast) return { model: fast, effort: /luna/.test(fast) ? "none" : "low" };
  } catch {}
  return { effort: "low" };
}

function leanCodexHome(): string {
  const home = join(STATE_DIR, "codex-home");
  const auth = join(home, "auth.json");
  try {
    mkdirSync(home, { recursive: true });
    if (!existsSync(auth)) symlinkSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), auth);
    return home;
  } catch {
    return process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }
}

/**
 * Codex can't stream text and has a ~7 s floor per call, so it is started right
 * away with our instructions replacing its own; run() just feeds the prompt.
 */
export function startCodexStream(system: string, choice = pickCodexModel()): Stream {
  const dir = mkdtempSync(join(tmpdir(), "ima-cx-"));
  const instructions = join(dir, "instructions.md");
  const out = join(dir, "out.txt");
  writeFileSync(instructions, redact(system));
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", `model_instructions_file="${instructions}"`, "-c", `model_reasoning_effort="${choice.effort}"`, "-o", out, "-C", dir, "-"];
  if (choice.model) args.splice(1, 0, "-m", choice.model);
  // A private Codex home with only the login: no MCP servers, plugins or AGENTS.md to load.
  const child = spawn("codex", args, { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, CODEX_HOME: leanCodexHome() } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  child.on("error", (e) => (stderr += e.message));
  child.stdin.on("error", () => {});
  return {
    async run(prompt, onLine) {
      child.stdin.end(redact(prompt));
      const code = await closed;
      let text = "";
      try {
        text = readFileSync(out, "utf8");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      if (!text.trim()) {
        // The fast model may not exist on this plan: one retry on Codex's defaults.
        if (choice.model) return startCodexStream(system, { effort: "low" }).run(prompt, onLine);
        throw new Error(`codex failed (${code}): ${stderr.slice(-300)}`);
      }
      for (const line of text.split("\n")) onLine(line);
      return text;
    },
  };
}

/** Anthropic API key: real streaming with thinking off. */
export function startApiStream(system: string): Stream {
  return {
    async run(prompt, onLine) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();
      let pending = "";
      let text = "";
      const stream = client.messages.stream({
        model: "claude-sonnet-5-5",
        max_tokens: 2000,
        system: redact(system),
        messages: [{ role: "user", content: redact(prompt) }],
        // Sonnet 5.5 turns thinking off with between_tools (accepted at effort high or below).
        thinking: { type: "between_tools" } as any,
        output_config: { effort: "low" },
      } as any);
      stream.on("text", (delta: string) => {
        text += delta;
        pending += delta;
        let i;
        while ((i = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
      });
      const final = await stream.finalMessage();
      if (pending) onLine(pending);
      if ((final as any).stop_reason === "refusal") throw new Error("model declined the request");
      return text;
    },
  };
}
