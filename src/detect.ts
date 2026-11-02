import { createHash } from "node:crypto";
import type { Candidate, Session } from "./types.ts";
import { redact, truncate } from "./clean.ts";
import { resolveRepo } from "./repo.ts";

const PURE_ACK = /^(ok(ay)?|k|yes|yep|yeah|y|sure|thanks|thank you|thx|ty|great|perfect|nice|cool|awesome|lgtm|go|go ahead|continue|proceed|do it|ship it|sounds good|done|next)[.! ]*$/i;

function describeAction(turn: Session["turns"][number]): string {
  const parts: string[] = [];
  if (turn.toolCalls.length) {
    const calls = turn.toolCalls.slice(-6).map((c) => {
      const flag = c.rejected ? " [REJECTED BY USER]" : c.isError ? " [ERROR]" : "";
      return `${c.name}: ${truncate(c.summary, 140)}${flag}`;
    });
    parts.push(`tools → ${calls.join(" | ")}`);
  }
  if (turn.text) parts.push(`said → ${truncate(turn.text.split("\n").slice(-6).join(" "), 500)}`);
  if (turn.interrupted) parts.push("[USER INTERRUPTED THIS TURN]");
  return redact(parts.join("\n"));
}

/** Every user message that reacts to an agent action is a candidate. */
export function candidatesFrom(sessions: Session[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of sessions) {
    const repo = resolveRepo(s.cwd).key;
    let lastRequest = "";
    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i];
      if (t.role !== "user") continue;
      const prev = s.turns[i - 1];
      const text = t.text.trim();
      if (prev?.role === "assistant" && text && !PURE_ACK.test(text) && text.length <= 2500) {
        const hardSignals: string[] = [];
        if (prev.interrupted) hardSignals.push("interrupted");
        if (prev.toolCalls.some((c) => c.rejected)) hardSignals.push("tool_rejected");
        if (prev.toolCalls.at(-1)?.isError) hardSignals.push("tool_error");
        out.push({
          id: createHash("sha1").update(`${s.id}:${t.ts}:${text}`).digest("hex").slice(0, 12),
          tool: s.tool,
          sessionId: s.id,
          cwd: s.cwd,
          repo,
          ts: t.ts,
          userText: redact(text),
          agentAction: describeAction(prev),
          agentFix: s.turns[i + 1]?.role === "assistant" ? describeAction(s.turns[i + 1]) : "",
          priorRequest: redact(truncate(lastRequest, 400)),
          hardSignals,
          recentCommands: prev.toolCalls.filter((c) => c.name === "Bash").map((c) => c.summary),
        });
      }
      lastRequest = text;
    }
  }
  return out;
}

export function allBashCommands(sessions: Session[]): { repo: string; command: string }[] {
  const out: { repo: string; command: string }[] = [];
  for (const s of sessions) {
    const repo = resolveRepo(s.cwd).key;
    for (const t of s.turns) for (const c of t.toolCalls) if (c.name === "Bash" && !c.rejected) out.push({ repo, command: c.summary });
  }
  return out;
}
