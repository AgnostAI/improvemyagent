import { readdirSync, statSync, existsSync } from "node:fs";
import { forEachJsonLine } from "../lines.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session, ToolCall, Turn } from "../types.ts";
import { redact, stripInjected } from "../clean.ts";

const ROOT = join(homedir(), ".claude", "projects");
const REJECTED = "doesn't want to proceed with this tool use";

export function claudeSessionFiles(sinceMs: number): string[] {
  if (!existsSync(ROOT)) return [];
  const files: string[] = [];
  for (const dir of readdirSync(ROOT)) {
    const full = join(ROOT, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(full, f);
      if (statSync(path).mtimeMs >= sinceMs) files.push(path);
    }
  }
  return files;
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.url === "string") return input.url;
  if (typeof input.description === "string") return input.description;
  return redact(JSON.stringify(input)).slice(0, 160);
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function parseClaudeSession(file: string): Session | null {
  const turns: Turn[] = [];
  const callsById = new Map<string, ToolCall>();
  let cwd = "";
  let branch: string | undefined;
  let model: string | undefined;
  let id = "";
  let startedAt = "";
  let current: Turn | null = null;

  const flush = () => {
    if (current) turns.push(current);
    current = null;
  };

  forEachJsonLine(file, (ev) => {
    if (ev.isSidechain) return;
    if (ev.cwd && !cwd) cwd = ev.cwd;
    if (ev.gitBranch) branch = ev.gitBranch;
    if (ev.sessionId && !id) id = ev.sessionId;
    if (ev.timestamp && !startedAt) startedAt = ev.timestamp;

    if (ev.type === "assistant") {
      const msg = ev.message ?? {};
      if (msg.model && msg.model !== "<synthetic>") model = msg.model;
      if (!current) current = { role: "assistant", text: "", toolCalls: [], interrupted: false, ts: ev.timestamp };
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) current.text += (current.text ? "\n" : "") + block.text;
        if (block.type === "tool_use") {
          const call: ToolCall = { name: block.name, summary: summarizeInput(block.name, block.input), isError: false, rejected: false };
          current.toolCalls.push(call);
          callsById.set(block.id, call);
        }
      }
      return;
    }

    if (ev.type !== "user" || ev.isMeta) return;
    const content = ev.message?.content;

    if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
      for (const b of content) {
        if (b?.type !== "tool_result") return;
        const call = callsById.get(b.tool_use_id);
        if (!call) return;
        const out = typeof b.content === "string" ? b.content : textOf(b.content);
        if (b.is_error) call.isError = true;
        if (out.includes(REJECTED)) call.rejected = true;
      }
      return;
    }

    if (ev.promptSource === "system" || ev.turnOrigin === "task_notification") return;
    const raw = textOf(content);
    if (/\[Request interrupted by user/.test(raw)) {
      const last: Turn | null = current ?? turns[turns.length - 1] ?? null;
      if (last && last.role === "assistant") last.interrupted = true;
    }
    const text = stripInjected(raw);
    if (!text) return;
    flush();
    turns.push({ role: "user", text, toolCalls: [], interrupted: false, ts: ev.timestamp });
  });
  flush();
  if (!id || turns.length === 0) return null;
  return { tool: "claude-code", id, file, cwd, branch, model, startedAt, turns };
}
