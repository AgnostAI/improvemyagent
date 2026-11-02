import { readdirSync, statSync, existsSync } from "node:fs";
import { forEachJsonLine } from "../lines.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session, ToolCall, Turn } from "../types.ts";
import { stripInjected } from "../clean.ts";

const ROOTS = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];

function walk(dir: string, out: string[], sinceMs: number) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, sinceMs);
    else if (name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) out.push(p);
  }
}

export function codexSessionFiles(sinceMs: number): string[] {
  const out: string[] = [];
  for (const root of ROOTS) if (existsSync(root)) walk(root, out, sinceMs);
  return out;
}

/** Pulls shell commands out of the various shapes Codex uses for tool calls. */
function commandsFrom(name: string, raw: string): string[] {
  let args: any = raw;
  try {
    args = JSON.parse(raw);
  } catch {}
  if (args && typeof args === "object") {
    if (Array.isArray(args.command)) return [args.command.join(" ")];
    if (typeof args.command === "string") return [args.command];
    if (typeof args.cmd === "string") return [args.cmd];
    if (typeof args.code === "string") raw = args.code;
  }
  // The desktop app wraps shell calls in JS: tools.exec_command({cmd:"…"})
  const cmds: string[] = [];
  for (const m of String(raw).matchAll(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      cmds.push(JSON.parse(`"${m[1]}"`));
    } catch {
      cmds.push(m[1]);
    }
  }
  return cmds;
}

/** Line types the parser never reads; they make up most of a rollout's bytes. */
const SKIP = /"type":"(token_count|token_usage_record|reasoning|item_completed|world_state|thread_settings_applied)"/;
const skipCodexLine = (head: string) => SKIP.test(head);

export function parseCodexSession(file: string): Session | null {
  const turns: Turn[] = [];
  const callsById = new Map<string, ToolCall>();
  let id = "";
  let cwd = "";
  let branch: string | undefined;
  let commit: string | undefined;
  let model: string | undefined;
  let startedAt = "";
  let current: Turn | null = null;

  const assistant = (ts: string): Turn => {
    if (!current) current = { role: "assistant", text: "", toolCalls: [], interrupted: false, ts };
    return current;
  };

  forEachJsonLine(file, (ev) => {
    const p = ev.payload ?? {};
    if (ev.type === "session_meta") {
      id = p.id ?? p.session_id ?? id;
      cwd = p.cwd ?? cwd;
      startedAt = p.timestamp ?? ev.timestamp ?? startedAt;
      branch = p.git?.branch ?? branch;
      commit = p.git?.commit_hash ?? commit;
      return;
    }
    if (ev.type === "turn_context") {
      model = p.model ?? model;
      if (!cwd && p.cwd) cwd = p.cwd;
      return;
    }
    if (ev.type === "event_msg" && p.type === "turn_aborted") {
      const last: Turn | null = current ?? turns[turns.length - 1] ?? null;
      if (last && last.role === "assistant") last.interrupted = true;
      return;
    }
    if (ev.type !== "response_item") return;

    if (p.type === "message" && p.role === "assistant") {
      const t = assistant(ev.timestamp);
      const text = (p.content ?? []).map((c: any) => c.text ?? "").join("\n").trim();
      if (text) t.text += (t.text ? "\n" : "") + text;
      return;
    }
    if (p.type === "message" && p.role === "user") {
      const text = (p.content ?? [])
        .map((c: any) => stripInjected(c.text ?? ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) return;
      if (current) turns.push(current);
      current = null;
      turns.push({ role: "user", text, toolCalls: [], interrupted: false, ts: ev.timestamp });
      return;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const raw = p.arguments ?? p.input ?? "";
      const cmds = commandsFrom(p.name, typeof raw === "string" ? raw : JSON.stringify(raw));
      const t = assistant(ev.timestamp);
      const summaries = cmds.length ? cmds : [String(typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 160)];
      for (const s of summaries) {
        const call: ToolCall = { name: cmds.length ? "Bash" : p.name, summary: s, isError: false, rejected: false };
        t.toolCalls.push(call);
        if (p.call_id) callsById.set(p.call_id, call);
      }
      return;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = callsById.get(p.call_id);
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      if (call && /aborted|rejected by user|declined/i.test(out.slice(0, 200))) call.rejected = true;
      if (call && /"exit_code"\s*:\s*[1-9]|Process exited with code [1-9]/.test(out.slice(0, 400))) call.isError = true;
    }
  }, skipCodexLine);
  if (current) turns.push(current);
  if (!id || turns.length === 0) return null;
  return { tool: "codex", id, file, cwd, branch, commit, model, startedAt, turns };
}
