// Gemini CLI records chats under ~/.gemini/tmp/<project>/chats/:
//   older: session-*.json  { sessionId, startTime, messages: [{ type, content, timestamp, toolCalls? }] }
//   newer: session-*.jsonl one record per line (a header, then messages; later lines may update earlier ids)
// <project>/.project_root holds the real working directory in newer versions.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Turn } from "../types.ts";
import { stripInjected } from "../clean.ts";
import { forEachJsonLine } from "../lines.ts";
import { toolCall } from "./util.ts";

const root = () => process.env.IMA_GEMINI_DIR ?? join(homedir(), ".gemini", "tmp");
const ASSISTANT = new Set(["gemini", "model", "assistant"]);

export function geminiSessionFiles(sinceMs: number): string[] {
  const r = root();
  if (!existsSync(r)) return [];
  const out: string[] = [];
  for (const project of readdirSync(r)) {
    const chats = join(r, project, "chats");
    if (!existsSync(chats)) continue;
    for (const f of readdirSync(chats)) {
      if (!/^session-.*\.jsonl?$/.test(f)) continue;
      const p = join(chats, f);
      if (statSync(p).mtimeMs >= sinceMs) out.push(p);
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
}

function loadMessages(file: string): { header: any; messages: any[] } {
  if (file.endsWith(".json")) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      return { header: doc, messages: doc.messages ?? [] };
    } catch {
      return { header: {}, messages: [] };
    }
  }
  let header: any = {};
  const byId = new Map<string, any>();
  const order: any[] = [];
  forEachJsonLine(file, (rec) => {
    const m = rec.message ?? rec;
    if (typeof m.type !== "string") {
      header = { ...header, ...rec };
      return;
    }
    if (m.id && byId.has(m.id)) Object.assign(byId.get(m.id), m);
    else {
      if (m.id) byId.set(m.id, m);
      order.push(m);
    }
  });
  return { header, messages: order };
}

export function parseGeminiSession(file: string): Session | null {
  const { header, messages } = loadMessages(file);
  const projectDir = join(file, "..", "..");
  let cwd = "";
  try {
    const r = readFileSync(join(projectDir, ".project_root"), "utf8").trim();
    if (r.startsWith("/")) cwd = r;
  } catch {}
  const turns: Turn[] = [];
  for (const m of messages) {
    const ts = m.timestamp ?? "";
    if (m.type === "user") {
      const text = stripInjected(textOf(m.content));
      if (text) turns.push({ role: "user", text, toolCalls: [], interrupted: false, ts });
      continue;
    }
    const prev = turns.at(-1);
    if (m.type === "info" && /cancel|interrupt/i.test(textOf(m.content))) {
      if (prev?.role === "assistant") prev.interrupted = true;
      continue;
    }
    if (!ASSISTANT.has(m.type)) continue;
    const turn: Turn = prev?.role === "assistant" ? prev : { role: "assistant", text: "", toolCalls: [], interrupted: false, ts };
    if (turn !== prev) turns.push(turn);
    const text = textOf(m.content).trim();
    if (text) turn.text += (turn.text ? "\n" : "") + text;
    for (const c of m.toolCalls ?? []) {
      turn.toolCalls.push(toolCall(c.name ?? "tool", c.args, { isError: c.status === "error", rejected: c.status === "cancelled" }));
    }
  }
  if (!turns.length) return null;
  return { tool: "gemini", id: header.sessionId ?? file, file, cwd, startedAt: header.startTime ?? turns[0].ts, turns };
}
