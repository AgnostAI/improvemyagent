// Cursor keeps agent chats in one SQLite file (globalStorage/state.vscdb), table cursorDiskKV:
//   composerData:<cid>          { createdAt, lastUpdatedAt, fullConversationHeadersOnly: [{ bubbleId }] }
//   bubbleId:<cid>:<bubbleId>   { type: 1 user | 2 assistant, text, createdAt, toolFormerData? }
// The working folder comes from the composerHeaders table when present.
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Session, Turn } from "../types.ts";
import { stripInjected } from "../clean.ts";
import { openReadOnly, query } from "../sqlite.ts";
import { isoFromMs, toolCall } from "./util.ts";

function dbPath(): string {
  if (process.env.IMA_CURSOR_DB) return process.env.IMA_CURSOR_DB;
  const user =
    platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "Cursor", "User")
      : platform() === "win32"
        ? join(process.env.APPDATA ?? "", "Cursor", "User")
        : join(homedir(), ".config", "Cursor", "User");
  return join(user, "globalStorage", "state.vscdb");
}

function parse(v: unknown): any {
  try {
    return JSON.parse(typeof v === "string" ? v : Buffer.from(v as Uint8Array).toString("utf8"));
  } catch {
    return undefined;
  }
}

function cwdsByComposer(db: NonNullable<ReturnType<typeof openReadOnly>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of query(db, "SELECT * FROM composerHeaders")) {
    const v = parse(row.value) ?? row;
    const id = row.composerId ?? row.key ?? v?.composerId;
    const cwd = v?.workspaceIdentifier?.uri?.fsPath ?? v?.agentLocation?.environment?.uri?.fsPath ?? v?.trackedGitRepos?.[0]?.repoPath;
    if (id && cwd) out.set(String(id).replace(/^composerHeaders?:/, ""), cwd);
  }
  return out;
}

/** Cursor has a single database, so this returns whole sessions rather than files. */
export function cursorSessions(sinceMs: number): Session[] {
  const file = dbPath();
  const db = openReadOnly(file);
  if (!db) return [];
  const sessions: Session[] = [];
  try {
    const cwds = cwdsByComposer(db);
    for (const row of query(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")) {
      const cid = String(row.key).slice("composerData:".length);
      const data = parse(row.value);
      if (!data) continue;
      const updated = Number(data.lastUpdatedAt ?? data.createdAt ?? 0);
      if (updated && updated < sinceMs) continue;
      const bubbles = new Map<string, any>();
      for (const b of query(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid", `bubbleId:${cid}:%`)) {
        bubbles.set(String(b.key).split(":").pop()!, parse(b.value));
      }
      const order: string[] = (data.fullConversationHeadersOnly ?? []).map((h: any) => h.bubbleId).filter((id: string) => bubbles.has(id));
      const ids = order.length ? order : [...bubbles.keys()];
      const turns: Turn[] = [];
      for (const id of ids) {
        const b = bubbles.get(id);
        if (!b) continue;
        const ts = isoFromMs(b.createdAt) || isoFromMs(data.createdAt);
        if (b.type === 1) {
          const text = stripInjected(b.text ?? "");
          if (text) turns.push({ role: "user", text, toolCalls: [], interrupted: false, ts });
          continue;
        }
        if (b.type !== 2) continue;
        const prev = turns.at(-1);
        const turn: Turn = prev?.role === "assistant" ? prev : { role: "assistant", text: "", toolCalls: [], interrupted: false, ts };
        if (turn !== prev) turns.push(turn);
        if (b.text) turn.text += (turn.text ? "\n" : "") + b.text;
        const t = b.toolFormerData;
        if (t?.name) {
          const rejected = t.userDecision === "rejected" || t.status === "cancelled" || /reject/i.test(String(t.additionalData?.status ?? ""));
          turn.toolCalls.push(toolCall(t.name, t.params ?? t.rawArgs, { isError: t.status === "error", rejected }));
        }
      }
      if (turns.length) sessions.push({ tool: "cursor", id: cid, file, cwd: cwds.get(cid) ?? "", startedAt: isoFromMs(data.createdAt), turns });
    }
  } finally {
    db.close();
  }
  return sessions;
}
