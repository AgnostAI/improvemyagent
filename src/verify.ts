import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rule, Verification } from "./types.ts";
import type { Context } from "./synthesize.ts";
import { llm, pool } from "./llm.ts";
import { truncate } from "./clean.ts";
import { commitAt } from "./repo.ts";

const MANAGERS = ["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pip"];

/** Tier A: deterministic checks that cost nothing. */
export function verifyStatic(rule: Rule, ctx: Context, bash: { repo: string; command: string }[]): Verification[] {
  const out: Verification[] = [];
  const sessions = new Set(rule.evidence.map((e) => e.sessionId)).size;
  if (rule.evidence.length) {
    out.push({ tier: "A", kind: "evidence", passed: sessions >= 2 || rule.evidence.length >= 3, detail: `${rule.evidence.length} corrections across ${sessions} session${sessions === 1 ? "" : "s"}` });
  }

  const facts = rule.repo ? ctx.repos.get(rule.repo)?.facts : undefined;
  if (facts?.exists && facts.packageManager) {
    const preferred = rule.text.match(new RegExp(`\\b(?:use|run|with)\\s+(${MANAGERS.join("|")})\\b`, "i"))?.[1]?.toLowerCase();
    if (preferred && ["pnpm", "npm", "yarn", "bun"].includes(preferred)) {
      const ok = preferred === facts.packageManager;
      out.push({ tier: "A", kind: "repo-facts", passed: ok, detail: ok ? `repo really uses ${preferred} (${facts.lockfiles.join(", ")})` : `rule says ${preferred} but repo lockfile says ${facts.packageManager}` });
    }
  }

  if (rule.guard) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(rule.guard.pattern);
    } catch {
      out.push({ tier: "A", kind: "guard", passed: false, detail: `invalid regex: ${rule.guard.pattern}` });
    }
    if (re) {
      const bad = [...new Set(rule.evidence.flatMap((e) => e.recentCommands))];
      const caught = bad.filter((c) => re!.test(c));
      const others = bad.length ? bash.filter((b) => (!rule.repo || b.repo === rule.repo) && !bad.includes(b.command)) : bash.filter((b) => !rule.repo || b.repo === rule.repo);
      const falsePos = others.filter((b) => re!.test(b.command));
      const fpRate = others.length ? falsePos.length / others.length : 0;
      const passed = (bad.length === 0 || caught.length > 0) && fpRate < 0.01;
      out.push({
        tier: "A",
        kind: "guard",
        passed,
        detail:
          (bad.length ? `blocks ${caught.length}/${bad.length} commands from the corrected moments` : `no recorded offending command`) +
          `; would block ${falsePos.length}/${others.length} of your other commands` +
          (falsePos.length ? ` (e.g. ${truncate(falsePos[0].command, 60)})` : ""),
      });
    }
  }
  return out;
}

const REPLAY_SCHEMA = { type: "object", properties: { response: { type: "string" } }, required: ["response"] };
const JUDGE_SCHEMA = {
  type: "object",
  properties: { repeats_mistake: { type: "boolean" }, reason: { type: "string" } },
  required: ["repeats_mistake", "reason"],
};
const JUDGE_SYSTEM = `You check whether an AI coding agent repeated a mistake.
You get: the developer's original request, the developer's real correction from last time, the lesson behind it, and the agent's new response to the same request.
repeats_mistake = true if the developer would need to give the same correction again to this new response. Judge only the specific mistake, nothing else.`;

function worktreeAt(root: string, iso: string, commit?: string): { dir: string; cleanup: () => void } | undefined {
  try {
    const sha = commit ?? commitAt(root, iso);
    if (!sha) return undefined;
    const dir = mkdtempSync(join(tmpdir(), "ima-replay-"));
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], { cwd: root, stdio: "ignore" });
    return {
      dir,
      cleanup: () => {
        try {
          execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: root, stdio: "ignore" });
        } catch {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch {
    return undefined;
  }
}

function existingInstructions(rule: Rule, ctx: Context): string {
  return ctx.files
    .filter((f) => ["claude-global", "claude-md", "agents-md", "codex-global", "opencode-global", "gemini-global", "gemini-md"].includes(f.kind))
    .filter((f) => f.scope === "global" || f.repo === rule.repo)
    .map((f) => `# ${f.path}\n${truncate(f.content, 4000)}`)
    .join("\n\n");
}

/**
 * Tier B: rewind to the moment before a real mistake, re-ask the same request
 * with and without the rule, and let a judge compare against the developer's
 * actual correction.
 */
export async function verifyReplay(rule: Rule, ctx: Context, samples = 3): Promise<Verification | undefined> {
  const moment = rule.evidence
    .filter((e) => e.priorRequest && e.priorRequest.length > 15)
    .find((e) => existsSync(e.cwd) || ctx.repos.get(e.repo)?.root);
  if (!moment) return { tier: "B", kind: "replay", passed: false, detail: "skipped: no replayable moment (repo no longer on disk)" };

  const root = ctx.repos.get(moment.repo)?.root;
  const session = ctx.sessions.find((s) => s.id === moment.sessionId);
  const wt = root ? worktreeAt(root, moment.ts, session?.commit) : undefined;
  const cwd = wt?.dir ?? (existsSync(moment.cwd) ? moment.cwd : root!);
  const base = existingInstructions(rule, ctx);
  const ask = `${moment.priorRequest}\n\n(Replay: do not modify anything. Investigate read-only if needed, then reply with exactly what you would do or say next, concretely: commands, files, and your message to me.)`;

  const run = (withRule: boolean, i: number) =>
    llm<{ response: string }>({
      system: `You are a coding agent working in this repository for a developer.\n\n${base}${withRule ? `\n\n# Rule\n${rule.text}` : ""}`,
      prompt: ask,
      schema: REPLAY_SCHEMA,
      model: "sonnet",
      cwd,
      tools: "Read,Grep,Glob",
      maxTurns: 8,
      noCache: true,
      salt: `${withRule}-${i}`,
    })
      .then((r) => r.response)
      .catch(() => undefined);

  const judge = (response: string) =>
    llm<{ repeats_mistake: boolean; reason: string }>({
      system: JUDGE_SYSTEM,
      prompt: `REQUEST: ${moment.priorRequest}\n\nREAL CORRECTION LAST TIME: "${truncate(moment.userText, 600)}"\nLESSON: ${moment.lesson}\n\nNEW RESPONSE:\n${truncate(response, 5000)}`,
      schema: JUDGE_SCHEMA,
      model: "haiku",
    }).catch(() => undefined);

  try {
    const arms = await pool(
      [...Array(samples).keys()].flatMap((i) => [{ withRule: false, i }, { withRule: true, i }]),
      4,
      async ({ withRule, i }) => {
        const resp = await run(withRule, i);
        const verdict = resp ? await judge(resp) : undefined;
        return { withRule, verdict };
      },
    );
    const tally = (w: boolean) => {
      const v = arms.filter((a) => a.withRule === w && a.verdict);
      return { bad: v.filter((a) => a.verdict!.repeats_mistake).length, n: v.length };
    };
    const without = tally(false);
    const withR = tally(true);
    if (!without.n || !withR.n) return { tier: "B", kind: "replay", passed: false, detail: "skipped: replay runs failed" };
    const passed = withR.bad < without.bad;
    const what = `replayed "${truncate(moment.priorRequest, 70)}" (${moment.ts.slice(0, 10)})`;
    if (without.bad === 0) return { tier: "B", kind: "replay", passed: false, detail: `${what}: couldn't reproduce the original mistake (0/${without.n} without the rule), so no signal` };
    return { tier: "B", kind: "replay", passed, detail: `${what}: mistake repeated ${without.bad}/${without.n} without the rule, ${withR.bad}/${withR.n} with it` };
  } finally {
    wt?.cleanup();
  }
}

export function badge(rule: Rule): string {
  const b = rule.verification.find((v) => v.tier === "B" && !v.detail.startsWith("skipped"));
  if (b) return b.passed ? "replayed ✓" : b.detail.includes("couldn't reproduce") ? "unverified (mistake didn't recur)" : "replay: no gain";
  const g = rule.verification.find((v) => v.kind === "guard");
  if (g) return g.passed ? "guard tested ✓" : "guard needs work";
  const f = rule.verification.find((v) => v.kind === "repo-facts");
  if (f) return f.passed ? "matches repo ✓" : "contradicts repo ✗";
  return "unverified";
}

