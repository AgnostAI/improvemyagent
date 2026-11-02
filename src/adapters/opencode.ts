// OpenCode keeps one JSON file per record under ~/.local/share/opencode/storage:
//   session/<projectID>/<sessionID>.json   { id, directory, time.created, parentID? }
//   message/<sessionID>/<messageID>.json   { id, role, time.created, modelID?, error? }
//   part/<messageID>/<partID>.json         { type: text|tool|…, text?, synthetic?, tool?, state? }
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Turn } from "../types.ts";
import { stripInjected } from "../clean.ts";
import { isoFromMs, toolCall } from "./util.ts";

const root = () => process.env.IMA_OPENCODE_DIR ?? join(homedir(), ".local", "share", "opencode", "storage");

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) : [];
}

export function opencodeSessionFiles(sinceMs: number): string[] {
  const dir = join(root(), "session");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const project of readdirSync(dir)) {
    const p = join(dir, project);
    if (!statSync(p).isDirectory()) continue;
    for (const f of jsonFiles(p)) if (statSync(f).mtimeMs >= sinceMs) out.push(f);
  }
  return out;
}

export function parseOpencodeSession(file: string): Session | null {
  const s = readJson(file);
  // Sub-sessions are spawned by the Task tool; there is no human in them.
  if (!s?.id || s.parentID) return null;
  const turns: Turn[] = [];
  let model: string | undefined;
  for (const mf of jsonFiles(join(root(), "message", s.id))) {
    const m = readJson(mf);
    if (!m?.id) continue;
    const ts = isoFromMs(m.time?.created) || isoFromMs(s.time?.created);
    const parts = jsonFiles(join(root(), "part", m.id)).map(readJson).filter(Boolean);
    if (m.role === "user") {
      const text = stripInjected(parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text ?? "").join("\n"));
      if (text) turns.push({ role: "user", text, toolCalls: [], interrupted: false, ts });
      continue;
    }
    if (m.role !== "assistant") continue;
    model = m.modelID ?? model;
    const prev = turns.at(-1);
    const turn: Turn = prev?.role === "assistant" ? prev : { role: "assistant", text: "", toolCalls: [], interrupted: false, ts };
    if (turn !== prev) turns.push(turn);
    for (const p of parts) {
      if (p.type === "text" && p.text && !p.synthetic) turn.text += (turn.text ? "\n" : "") + p.text;
      if (p.type === "tool") {
        const st = p.state ?? {};
        const err = String(st.error ?? "");
        turn.toolCalls.push(toolCall(p.tool ?? "tool", st.input, { isError: st.status === "error", rejected: /reject|denied|declin/i.test(err) }));
      }
    }
    if (/abort/i.test(String(m.error?.name ?? ""))) turn.interrupted = true;
  }
  if (!turns.length) return null;
  return { tool: "opencode", id: s.id, file, cwd: s.directory ?? "", model, startedAt: isoFromMs(s.time?.created), turns };
}
