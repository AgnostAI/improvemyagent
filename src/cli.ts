#!/usr/bin/env node
import "./quiet.ts";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Classified, Rule, Session } from "./types.ts";
import { claudeSessionFiles, parseClaudeSession } from "./adapters/claude.ts";
import { codexSessionFiles, parseCodexSession } from "./adapters/codex.ts";
import { opencodeSessionFiles, parseOpencodeSession } from "./adapters/opencode.ts";
import { geminiSessionFiles, parseGeminiSession } from "./adapters/gemini.ts";
import { cursorSessions } from "./adapters/cursor.ts";
import { allBashCommands, candidatesFrom } from "./detect.ts";
import { classify } from "./classify.ts";
import { inventory } from "./inventory.ts";
import { repoFacts, resolveRepo } from "./repo.ts";
import { refine, score, synthesize, type Context } from "./synthesize.ts";
import { targetsFor } from "./targets.ts";
import { verifyReplay, verifyStatic } from "./verify.ts";
import { applyRule, backupDir } from "./apply.ts";
import { loadNoMatch, loadRules, loadSeen, saveNoMatch, markApplied, markDismissed, mergeEvidence, saveRules, saveSeen, toStored, type StoredRule } from "./store.ts";
import { matchToRules } from "./match.ts";
import { baselineFor, track } from "./track.ts";
import { action, groupByDestination, renderCompact, renderOne, renderHeader, renderTracked, renderMarkdown, renderRule, tilde, type Stats } from "./report.ts";
import { available, BACKENDS, llm, probe, setBackend, setFallbacks, usage, type Backend } from "./llm.ts";
import { STATE_DIR } from "./paths.ts";
import { createHash } from "node:crypto";
import { truncate } from "./clean.ts";
import { notify, weeklyIsOn, weeklyOff, weeklyOn } from "./schedule.ts";
import { CODEX_RECENT, FOCUS, fastPrompt, parseLine, similar, startApiStream, startClaudeStream, startCodexStream, systemFor, type Stream } from "./fast.ts";

const LAST_RUN = join(STATE_DIR, "last-run.json");
const BACKEND_NAMES: Record<Backend, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", cursor: "Cursor", opencode: "OpenCode", "anthropic-api": "Anthropic API key" };
const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI", cursor: "Cursor" };

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: "string", default: "60d" },
    replay: { type: "string", default: "0" },
    report: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    apply: { type: "string" },
    max: { type: "string", default: "6" },
    model: { type: "string", default: "sonnet" },
    verbose: { type: "boolean", short: "v", default: false },
    deep: { type: "boolean", default: false },
    backend: { type: "string" },
    skip: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    weekly: { type: "boolean", default: false },
    notify: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`improvemyagent: learn from every time you corrected your coding agent.

Usage: npx improvemyagent [options]

  --since <30d>     how far back to read sessions (default 60d)
  --replay <n>      replay-verify the top n rules against real past moments (costs tokens; default 0)
  --report          print the report only, never write files
  --yes             apply every suggested rule without asking
  --apply <1,3>     apply these rule numbers from the last report (or --apply all)
  --max <n>         number of rules to show (default 6)
  --model <name>    model for writing rules (default sonnet)
  -v, --verbose     also show the evidence and checks behind each suggestion
  --deep            slower, more thorough: label every reply, then write rules
                    (also detects stale and conflicting lines in your files)
  --backend <name>  which agent runs the analysis: claude, codex, gemini, cursor,
                    opencode or anthropic-api (default: the first one installed)
  --skip <tools>    skip some tools, e.g. --skip cursor,gemini
                    (reads Claude Code, Codex, OpenCode, Gemini CLI and Cursor)
  --weekly          check in every Monday and notify you when there's something new
                    (only reports, never applies; --weekly off to stop)

Everything runs locally through the coding agent you already use. Nothing is uploaded.`);
  process.exit(0);
}

/** clack's spinner redraws with ANSI codes; outside a terminal print plain lines instead. */
function spinner() {
  if (process.stdout.isTTY) {
    const s = p.spinner();
    // Progress lines vanish when a step finishes; --verbose keeps them.
    return { start: s.start, message: s.message, stop: (m: string) => (args.verbose ? s.stop(m) : s.clear()) };
  }
  const log = args.verbose ? (m: string) => console.log(m) : () => {};
  return { start: (m: string) => log(`… ${m}`), message: (_m: string) => {}, stop: (m: string) => log(`✓ ${m}`) };
}

const T0 = Date.now();
/** IMA_DEBUG=1 prints how long each stage took. */
function mark(stage: string) {
  if (process.env.IMA_DEBUG) console.error(`[ima] ${stage} at ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

function sinceMs(s: string): number {
  const m = s.match(/^(\d+)([dhw])$/);
  if (!m) return 0;
  const n = Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
  return Date.now() - n;
}

let analyzedWith = "";

async function main() {
  const interactive = process.stdout.isTTY && !args.report;
  p.intro(pc.bgCyan(pc.black(" improvemyagent ")));
  if (args.apply) return applyFromLastRun(args.apply);
  if (args.weekly) return weekly(positionals[0] === "off");

  const wanted = args.backend as Backend | undefined;
  if (wanted && !BACKENDS.includes(wanted)) {
    p.cancel(`Unknown backend "${wanted}". Use one of: ${BACKENDS.join(", ")}.`);
    process.exit(1);
  }
  const installed = wanted ? [wanted] : BACKENDS.filter(available);
  if (!installed.length) {
    p.cancel("No coding agent found to run the analysis. Install and log in to one of: Claude Code, Codex, Gemini CLI, Cursor CLI or OpenCode (or set ANTHROPIC_API_KEY).");
    process.exit(1);
  }
  const fast = !args.deep && Number(args.replay) === 0;
  // Fast path: start the model now, so its startup overlaps with reading sessions.
  // Fast path: start the first agent's two streams now, so their startup overlaps with reading sessions.
  const streams = fast ? makeStreams(installed[0]) : undefined;
  // Deep path: test every installed agent at once (installed AND logged in?) while sessions load.
  const probes = fast ? new Map<Backend, Promise<string | undefined>>() : new Map(installed.map((b) => [b, probe(b)]));

  const since = sinceMs(args.since!);
  const s1 = spinner();
  s1.start("Reading your coding agent sessions");
  const sessions: Session[] = [];
  const skip = new Set((args.skip ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const add = (s: Session | null) => s && sessions.push(s);
  if (!skip.has("claude")) claudeSessionFiles(since).forEach((f) => add(parseClaudeSession(f)));
  if (!skip.has("codex")) codexSessionFiles(since).forEach((f) => add(parseCodexSession(f)));
  if (!skip.has("opencode")) opencodeSessionFiles(since).forEach((f) => add(parseOpencodeSession(f)));
  if (!skip.has("gemini")) geminiSessionFiles(since).forEach((f) => add(parseGeminiSession(f)));
  if (!skip.has("cursor")) cursorSessions(since).forEach(add);
  const perTool = new Map<string, number>();
  for (const x of sessions) perTool.set(x.tool, (perTool.get(x.tool) ?? 0) + 1);
  const toolSummary = [...perTool].map(([t, n]) => `${n} ${TOOL_NAMES[t] ?? t}`).join(" + ");
  const messages = sessions.reduce((a, s) => a + s.turns.filter((t) => t.role === "user").length, 0);
  s1.stop(`Read ${toolSummary || "0"} sessions (${messages} of your messages)`);
  if (!sessions.length) {
    p.outro("No coding agent sessions found yet (Claude Code, Codex, OpenCode, Gemini CLI, Cursor). Use one for a bit, then come back.");
    return;
  }

  mark("sessions read");
  if (fast) return fastRun({ sessions, installed, streams, messages, interactive });
  // Use the fastest subscription that works; anything else that works is a fallback.
  const order = BACKENDS.filter((b) => probes.has(b));
  let backendName: Backend | undefined;
  const problems: string[] = [];
  for (const b of order) {
    const err = await probes.get(b);
    if (!err) {
      backendName = b;
      break;
    }
    problems.push(`${BACKEND_NAMES[b]}: ${err}`);
  }
  if (!backendName) {
    p.cancel(`None of your coding agents could run the analysis:\n${problems.map((x) => "  " + x).join("\n")}\nLog in to one of them (e.g. run \`claude\` or \`codex\` once), then try again.`);
    process.exit(1);
  }
  setBackend(backendName);
  const active = backendName;
  // Later agents become fallbacks as their checks come back fine.
  const rest = order.slice(order.indexOf(active) + 1);
  const fallbackList: Backend[] = [];
  setFallbacks(fallbackList, (from, to, why) => p.log.warn(`${BACKEND_NAMES[from]} stopped working (${why.slice(0, 80)}). Switching to ${BACKEND_NAMES[to]}.`));
  for (const b of rest) probes.get(b)!.then((err) => !err && fallbackList.push(b));
  analyzedWith = BACKEND_NAMES[active];
  if (args.verbose) p.log.info(`Analyzing with your ${BACKEND_NAMES[active]} login${problems.length ? pc.dim(` (skipped: ${problems.map((x) => x.split(":")[0]).join(", ")})`) : ""}`);
  const candidates = candidatesFrom(sessions);
  const s2 = spinner();
  s2.start(`Finding corrections in ${candidates.length} replies`);
  const classified = await classify(candidates, {
    onProgress: (d, t, found) => s2.message(`Finding corrections · ${d}/${t} new replies checked · ${found} found so far`),
  });
  const corrections = classified.filter((c) => c.label === "correction");
  const prefs = classified.filter((c) => c.label === "durable_preference");
  const lessons = classified.filter((c) => c.lesson && (c.label === "durable_preference" || (c.label === "correction" && (c.durable || c.hardSignals.length > 0))));
  mark("classified");
  // Never report "no corrections" when the model calls were actually failing.
  if (usage.failures > 0 && usage.failures >= Math.max(1, usage.calls / 2)) {
    s2.stop("Most analysis calls failed");
    p.cancel(`${usage.failures} of ${usage.calls} analysis calls failed. Last error: ${usage.lastError}`);
    process.exit(1);
  }
  const remembered = candidates.length - (classified.fresh ?? 0);
  s2.stop(`Found ${corrections.length} corrections and ${prefs.length} lasting preferences${remembered ? ` (${classified.fresh} new replies checked, ${remembered} remembered)` : ""}`);

  const files = inventory(sessions);
  const repos = buildRepos(sessions);
  const ctx: Context = { sessions, files, repos };

  // Rules persist across runs: known problems gather evidence, only new ones become new rules.
  const store = loadRules();
  const correctionPool = classified.filter((c) => c.label === "correction" || c.label === "durable_preference");
  const s3 = spinner();
  s3.start(store.length ? `Checking ${correctionPool.length} corrections against your ${store.length} saved rules` : `Turning ${lessons.length} lessons into rules`);
  // Only corrections not already filed under a rule need matching.
  const filed = new Set(store.flatMap((r) => r.evidence.map((e) => e.id)));
  mark("inventory done");
  // Corrections that matched nothing are only re-checked when the set of rules changes.
  const rulesKey = store.map((r) => r.id).sort().join(",");
  const noMatch = loadNoMatch(rulesKey);
  const toMatch = correctionPool.filter((c) => !filed.has(c.id) && !noMatch.has(c.id));
  const matched = await matchToRules(toMatch, store);
  saveNoMatch(rulesKey, [...noMatch, ...toMatch.filter((c) => !matched.has(c.id)).map((c) => c.id)]);
  for (const r of store) r.evidence = mergeEvidence(r.evidence, correctionPool.filter((c) => matched.get(c.id) === r.id));
  // Lessons already turned into rules (or dropped as weak) in an earlier run aren't re-processed.
  const seen = loadSeen();
  mark("matched to saved rules");
  const unfiled = lessons.filter((l) => !matched.has(l.id) && !filed.has(l.id));
  // Skip rule writing entirely when nothing is new; when something is, earlier leftovers
  // come along so a problem that recurs slowly can still build up enough evidence.
  const fresh = unfiled.some((l) => !seen.has(l.id)) ? unfiled : [];
  let created = 0;
  if (fresh.length) {
    s3.message(`Turning ${fresh.length} new lessons into rules, checking them against ${files.length} files you already have`);
    const known = store.map((r) => r.title);
    let newRules = await synthesize(fresh, ctx, { model: args.model, avoid: known });
    s3.message("Merging overlaps and dropping weak rules");
    const refined = await refine(newRules, ctx, store.filter((x) => x.lifecycle !== "removed").map((x) => ({ id: x.id, text: x.text })));
    newRules = refined.rules;
    // Candidates that repeat a saved rule just add evidence to it.
    for (const d of refined.duplicates) {
      const known = store.find((x) => x.id === d.existingId);
      if (known) known.evidence = mergeEvidence(known.evidence, d.evidence);
    }
    for (const r of newRules) {
      if (store.some((x) => x.id === r.id)) continue;
      store.push(toStored(r));
      created++;
    }
  }
  mark("rules written");
  saveSeen([...seen, ...lessons.map((l) => l.id)]);
  // An applied rule the developer deleted by hand is no longer tracked.
  for (const r of store) {
    if (r.lifecycle !== "applied" || !r.files?.length) continue;
    if (!r.files.some((f) => existsSync(f) && readFileSync(f, "utf8").includes(r.text))) r.lifecycle = "removed";
  }
  saveRules(store);

  const toRule = (x: StoredRule): Rule => ({ ...x, destinations: [], bridges: [], verification: [], score: score(x.evidence) + (x.status === "IGNORED" ? 1 : 0) });
  let rules = store
    .filter((x) => x.lifecycle === "suggested")
    .map(toRule)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(args.max));
  const allTools = new Set(sessions.map((x) => x.tool));
  for (const r of rules) {
    const t = targetsFor(r, repos, allTools);
    r.destinations = t.write;
    r.bridges = t.bridges;
    r.baseline = baselineFor(r, sessions);
  }
  const tracked = store.filter((x) => x.lifecycle === "applied").map((x) => ({ rule: x, tracking: track(x, sessions) }));
  s3.stop(`${created} new rule${created === 1 ? "" : "s"}, ${rules.length} to suggest${tracked.length ? `, ${tracked.length} applied being tracked` : ""}`);

  if (!rules.length && !tracked.length) {
    p.outro("No repeated corrections found. Your agents are behaving!");
    return;
  }

  const bash = allBashCommands(sessions);
  for (const r of rules) r.verification.push(...verifyStatic(r, ctx, bash));
  const replayN = Number(args.replay);
  if (replayN > 0) {
    const targets = rules.filter((r) => (r.status === "NEW" || r.status === "IGNORED") && r.evidence.length).slice(0, replayN);
    const s4 = spinner();
    s4.start(`Replaying ${targets.length} past moments with and without each rule`);
    let done = 0;
    await Promise.all(
      targets.map(async (r) => {
        const v = await verifyReplay(r, ctx);
        if (v) r.verification.push(v);
        s4.message(`Replaying past moments · ${++done}/${targets.length}`);
      }),
    );
    s4.stop(`Replayed ${targets.length} rules`);
  }

  const stats: Stats = {
    tools: toolSummary,
    messages,
    corrections: corrections.length,
    preferences: prefs.length,
    interrupts: candidates.filter((c) => c.hardSignals.includes("interrupted")).length,
    rejections: candidates.filter((c) => c.hardSignals.includes("tool_rejected")).length,
    instructionFiles: files.length,
    days: Math.round((Date.now() - (since || Math.min(...sessions.map((s) => Date.parse(s.startedAt) || Date.now())))) / 86_400_000),
  };

  return finish({ rules, repos, stats, tracked, messages, interactive });
}

/** Repos seen in the sessions; newest sessions first so each repo points at the checkout used most recently. */
function buildRepos(sessions: Session[]): Context["repos"] {
  const repos: Context["repos"] = new Map();
  for (const s of [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const ref = resolveRepo(s.cwd);
    const r = repos.get(ref.key) ?? { root: ref.root, facts: repoFacts(ref.root), tools: new Set<string>() };
    if (!r.root && ref.root) Object.assign(r, { root: ref.root, facts: repoFacts(ref.root) });
    r.tools.add(s.tool);
    repos.set(ref.key, r);
  }
  repos.delete("~");
  return repos;
}

const FAST_SCHEMA = { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"] };

/** Two topic-split streams for an agent, started immediately where the agent allows it. */
function makeStreams(b: Backend): Stream[] {
  const per = Math.ceil(Number(args.max) / 2);
  if (b === "codex") return [{ ...startCodexStream(systemFor(Number(args.max))), recent: CODEX_RECENT }];
  return FOCUS.map((f, i) => {
    const system = systemFor(per, f, i === 0);
    if (b === "claude") return startClaudeStream(system);
    if (b === "anthropic-api") return startApiStream(system);
    // Gemini, Cursor, OpenCode: one structured call each (same line format, as JSON).
    return {
      async run(prompt: string, onLine: (line: string) => void) {
        setBackend(b);
        const out = await llm<{ lines: string[] }>({ system, prompt, schema: FAST_SCHEMA, model: "sonnet", noCache: true });
        for (const l of out.lines) onLine(l);
        return out.lines.join("\n");
      },
    };
  });
}

/**
 * Default run: one streamed call reads every reply and writes the ranked rules
 * directly; each rule prints the moment it arrives.
 */
async function fastRun(o: { sessions: Session[]; installed: Backend[]; streams?: Stream[]; messages: number; interactive: boolean }) {
  const { sessions, messages } = o;
  // Oldest first, so ids stay put as new replies arrive (keeps the prompt cache warm).
  const candidates = candidatesFrom(sessions).sort((a, b) => a.ts.localeCompare(b.ts));
  const files = inventory(sessions);
  const repos = buildRepos(sessions);
  const roots = new Map([...repos].map(([k, r]) => [k, r.root]));
  const allTools = new Set(sessions.map((x) => x.tool));
  const store = loadRules();
  const known = new Set(store.map((x) => x.id));
  const saved = store.filter((x) => x.lifecycle === "suggested");
  const appliedRules = store.filter((x) => x.lifecycle === "applied");
  const existing = files
    .filter((f) => /md|rule|prompt|memory/.test(f.kind))
    .map((f) => `# ${tilde(f.path)}\n${truncate(f.content, 1500)}`)
    .join("\n\n")
    .slice(0, 6000);
  const promptFor = (recent?: number) => fastPrompt({ cands: candidates, existing, saved, applied: appliedRules, dismissed: store.filter((x) => x.lifecycle === "dismissed"), recent });

  const perTool = new Map<string, number>();
  for (const x of sessions) perTool.set(x.tool, (perTool.get(x.tool) ?? 0) + 1);
  const toolSummary = [...perTool].map(([t, n]) => `${n} ${TOOL_NAMES[t] ?? t}`).join(" + ");
  const reading = `${messages.toLocaleString()} messages · ${toolSummary} sessions`;
  // A live line while the model reads, instead of an empty gap; it becomes the summary line.
  const tty = process.stdout.isTTY;
  const spin = tty ? p.spinner() : spinner();
  spin.start(`Reading ${reading}`);
  const ticker = setTimeout(() => spin.message(`Reading ${reading} · finding what you keep correcting`), 1500);
  const rules: Rule[] = [];
  const seen: { id: string; ids: number[] }[] = [];
  let printed = false;
  const evidenceOf = (ids: number[], lesson: string): Classified[] =>
    ids.filter((i) => candidates[i]).map((i) => ({ ...candidates[i], label: "correction", lesson, durable: true }));
  const onLine = (line: string) => {
    const f = parseLine(line);
    if (!f) return;
    if (f.kind === "seen") return void seen.push(f);
    if (rules.length >= Number(args.max)) return;
    const reuse = /^r:[0-9a-f]{8}$/.test(f.rule) ? store.find((x) => x.id === f.rule.slice(2)) : undefined;
    const text = reuse?.text ?? f.rule;
    if (rules.some((r) => r.text === text || similar(r.text, text))) return;
    const scope = reuse?.scope ?? (f.scope !== "global" && repos.has(f.scope) ? "repo" : "global");
    const repo = reuse?.repo ?? (scope === "repo" ? f.scope : undefined);
    const evidence = mergeEvidence(reuse?.evidence ?? [], evidenceOf(f.ids, text));
    const rule: Rule = {
      id: reuse?.id ?? createHash("sha1").update(text).digest("hex").slice(0, 8),
      title: reuse?.title ?? text.split(/\s+/).slice(0, 6).join(" "),
      text,
      kind: reuse?.kind ?? "workflow",
      scope,
      repo,
      status: "NEW",
      enforcement: "text",
      destinations: [],
      bridges: [],
      evidence,
      rationale: reuse?.rationale ?? `You corrected this ${f.ids.length}× in these sessions.`,
      score: 0,
      verification: [],
    };
    const t = targetsFor(rule, repos, allTools);
    rule.destinations = t.write;
    rule.bridges = t.bridges;
    rule.mentions = f.count ?? f.ids.length;
    rules.push(rule);
    // Print each rule the moment it arrives.
    if (!printed) {
      clearTimeout(ticker);
      const summary = `${reading} ${pc.dim(`· via your ${analyzedWith}${analyzedWith.includes("key") ? "" : " login"}`)}`;
      if (tty) spin.stop(summary);
      else p.log.step(summary);
      console.log(pc.gray("│"));
      printed = true;
      mark("first rule on screen");
    }
    console.log(renderOne(rule, rules.length, roots));
  };

  // Two parallel streams per agent; if both fail, the next installed agent takes over.
  let done = false;
  const problems: string[] = [];
  for (const [k, b] of o.installed.entries()) {
    const streams = k === 0 && o.streams ? o.streams : makeStreams(b);
    analyzedWith = BACKEND_NAMES[b];
    const results = await Promise.allSettled(streams.map((st) => st.run(promptFor(st.recent), onLine)));
    if (results.some((r) => r.status === "fulfilled")) {
      done = true;
      break;
    }
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    problems.push(`${BACKEND_NAMES[b]}: ${String(failed?.reason?.message ?? failed?.reason).slice(0, 120)}`);
  }
  if (!done) {
    clearTimeout(ticker);
    spin.stop("Couldn't run the analysis");
    p.cancel(`None of your coding agents could run the analysis:\n${problems.map((x) => "  " + x).join("\n") || "  Claude: not logged in"}\nLog in to one of them (e.g. run \`claude\` or \`codex\` once), then try again.`);
    process.exit(1);
  }
  clearTimeout(ticker);
  if (!printed) spin.stop(`Read ${reading}`);
  mark("streamed");

  // Remember rules across runs (stable wording) and feed "did it work?" tracking.
  for (const r of rules) {
    const known = store.find((x) => x.id === r.id);
    if (known) known.evidence = r.evidence;
    else store.push(toStored(r));
  }
  for (const s of seen) {
    const known = store.find((x) => x.id === s.id && x.lifecycle === "applied");
    if (known) known.evidence = mergeEvidence(known.evidence, evidenceOf(s.ids, known.text));
  }
  for (const r of store) {
    if (r.lifecycle !== "applied" || !r.files?.length) continue;
    if (!r.files.some((f) => existsSync(f) && readFileSync(f, "utf8").includes(r.text))) r.lifecycle = "removed";
  }
  saveRules(store);
  for (const r of rules) r.baseline = baselineFor(r, sessions);
  const tracked = store.filter((x) => x.lifecycle === "applied").map((x) => ({ rule: x, tracking: track(x, sessions) }));
  if (args.notify) {
    // Weekly run: only ping when there's something to look at.
    const fresh = rules.filter((r) => !known.has(r.id)).length;
    const n = (v: string) => tracked.filter((t) => t.tracking?.verdict === v).length;
    const parts = [fresh && `${fresh} new rule${fresh === 1 ? "" : "s"} to review`, n("working") && `${n("working")} working`, n("not_sticking") && `${n("not_sticking")} not sticking`].filter(Boolean);
    if (parts.length) {
      notify(parts.join(" · "));
      console.log(pc.dim(`Notified: ${parts.join(" · ")}`));
    }
  }
  const stats: Stats = {
    tools: [...allTools].join(" + "),
    messages,
    corrections: new Set(rules.flatMap((r) => r.evidence.map((e) => e.id))).size,
    preferences: 0,
    interrupts: candidates.filter((c) => c.hardSignals.includes("interrupted")).length,
    rejections: candidates.filter((c) => c.hardSignals.includes("tool_rejected")).length,
    instructionFiles: files.length,
    days: 0,
  };
  return finish({ rules, repos, stats, tracked, messages, interactive: o.interactive, streamed: true });
}

interface Finish {
  rules: Rule[];
  repos: Context["repos"];
  stats: Stats;
  tracked: { rule: StoredRule; tracking?: ReturnType<typeof track> }[];
  messages: number;
  interactive: boolean;
  /** Rules were already printed while streaming. */
  streamed?: boolean;
  summary?: string;
}

/** Shared ending: save the run, print the list (unless streamed), then apply or show the next step. */
async function finish(o: Finish) {
  let { rules } = o;
  const { repos, stats, tracked, messages, interactive } = o;
  const roots = new Map([...repos].map(([k, r]) => [k, r.root]));
  // Same-destination rules sit together, so the numbers people --apply match what they see
  // (streamed rules keep the order they appeared in).
  if (!o.streamed) rules = groupByDestination(rules, roots);
  const reportDir = join(STATE_DIR, "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.md`);
  writeFileSync(reportPath, renderMarkdown(stats, rules));
  writeFileSync(LAST_RUN, JSON.stringify({ at: new Date().toISOString(), rules, roots: [...roots] }));

  if (tracked.length) console.log("\n" + renderTracked(tracked));
  if (o.streamed) {
    if (!rules.length) {
      p.outro("No repeated corrections found. Your agents are behaving!");
      return;
    }
  } else if (args.verbose) {
    console.log("\n" + renderHeader(stats) + "\n");
    rules.forEach((r, i) => console.log(renderRule(r, i) + "\n"));
    console.log(pc.dim(`${usage.calls} model calls (${usage.cached} cached) · $${usage.costUsd.toFixed(2)}`));
  } else {
    p.log.step(o.summary ?? `${stats.corrections} corrections in ${messages.toLocaleString()} messages ${pc.dim(`· via your ${analyzedWith} login`)}`);
    console.log(pc.gray("│") + "\n" + renderCompact(rules, roots));
  }

  const applicable = rules.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== "CONFLICT");
  if (!interactive && !args.yes) {
    // Two lines: the action (bright), then where the receipts are (dim).
    const example = applicable.slice(0, 2).map(({ i }) => i + 1).join(",") || "1";
    const files = [...new Set(rules.flatMap((r) => r.destinations.map((d) => basename(d))))].join(" / ") || "AGENTS.md";
    p.outro(`Add to ${files}:  ${pc.bold(pc.green(`npx improvemyagent --apply ${example}`))}   ${pc.dim("or")}   ${pc.bold(pc.green("--apply all"))}`);
    console.log(pc.dim(`   Receipts: ${tilde(reportPath)}`));
    if (!args.notify && !weeklyIsOn()) console.log(pc.dim(`   Check in every week: npx improvemyagent --weekly`));
    return;
  }

  let chosen: number[];
  if (args.yes) chosen = applicable.map(({ i }) => i);
  else {
    // The list is already on screen; just ask for numbers instead of repeating it as a checklist.
    const answer = await p.text({
      message: "Which should I add? (e.g. 1,3 or all; enter to skip)",
      placeholder: "1,2",
      defaultValue: "",
    });
    if (p.isCancel(answer)) return p.outro("Nothing applied.");
    const raw = String(answer ?? "").trim().toLowerCase();
    chosen =
      raw === "all"
        ? applicable.map(({ i }) => i)
        : raw
            .split(/[\s,]+/)
            .map((x) => Number(x) - 1)
            .filter((i) => applicable.some((a) => a.i === i));
    const rejected = applicable.filter(({ i }) => !chosen.includes(i));
    // Only offer to silence the rest when some were picked; a plain enter just skips for now.
    if (rejected.length && chosen.length) {
      const never = await p.confirm({ message: `Stop suggesting the ${rejected.length} you skipped?`, initialValue: false });
      if (never === true) markDismissed(rejected.map(({ r }) => r.id));
    }
  }

  let applied = 0;
  for (const i of chosen.sort((a, b) => a - b)) {
    const r = rules[i];
    if (!r || r.status === "CONFLICT") continue;
    const root = r.repo ? repos.get(r.repo)?.root : undefined;
    const changes = applyRule(r, root, false);
    for (const c of changes) p.log.success(`${i + 1}. ${c.action} → ${tilde(c.file)}`);
    markApplied(r, r.destinations);
    applied++;
  }
  const b = backupDir();
  p.outro(applied ? `Applied ${applied} rule${applied === 1 ? "" : "s"}. Backups in ${tilde(b ?? STATE_DIR)}. Repo files are left uncommitted for you to review.` : "Nothing applied.");
}

/** --apply uses the saved last report, so the numbers always match what you saw. */
function applyFromLastRun(list: string) {
  if (!existsSync(LAST_RUN)) {
    p.cancel("No report yet. Run `npx improvemyagent` first.");
    process.exit(1);
  }
  const last = JSON.parse(readFileSync(LAST_RUN, "utf8")) as { rules: Rule[]; roots: [string, string | undefined][] };
  const roots = new Map(last.roots);
  let applied = 0;
  const nums = list.trim().toLowerCase() === "all" ? last.rules.map((_, i) => i + 1) : list.split(",").map((x) => Number(x.trim()));
  for (const n of nums) {
    const r = last.rules[n - 1];
    if (!r) {
      p.log.warn(`No suggestion #${n} in the last report.`);
      continue;
    }
    if (r.status === "CONFLICT") {
      p.log.warn(`#${n} is a conflict between two existing lines; resolve it by hand.`);
      continue;
    }
    const changes = applyRule(r, r.repo ? roots.get(r.repo) : undefined, false);
    markApplied(r, r.destinations);
    if (!changes.length) p.log.info(`${n}. already applied`);
    for (const c of changes) p.log.success(`${n}. ${c.action} → ${tilde(c.file)}`);
    if (changes.length) applied++;
  }
  const b = backupDir();
  p.outro(applied ? `Applied ${applied}. Backups in ${tilde(b ?? STATE_DIR)}. Repo files are left uncommitted.` : "Nothing applied.");
}

function weekly(off: boolean) {
  if (off) return p.outro(weeklyOff() ? "Weekly check-in is off." : "Weekly check-in wasn't on.");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const when = weeklyOn(version);
  p.outro(`${when}, improvemyagent reads your week and notifies you if there's a new rule or one isn't sticking.\n   It never applies anything by itself. Stop it with: npx improvemyagent --weekly off`);
}

main().catch((e) => {
  p.cancel(String(e?.message ?? e));
  process.exit(1);
});
