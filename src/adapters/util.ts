import type { ToolCall } from "../types.ts";
import { redact } from "../clean.ts";

/** Short human form of a tool's input: the command, the path, or truncated JSON. */
export function summarize(input: unknown): string {
  let v: any = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return redact(v).slice(0, 160);
    }
  }
  if (!v || typeof v !== "object") return "";
  for (const k of ["command", "cmd", "file_path", "filePath", "path", "target_file", "pattern", "query", "url", "description"]) {
    const x = v[k];
    if (typeof x === "string") return x;
    if (Array.isArray(x) && x.every((y) => typeof y === "string")) return x.join(" ");
  }
  return redact(JSON.stringify(v)).slice(0, 160);
}

const SHELL_TOOLS = /^(bash|shell|run_shell_command|run_terminal_cmd|run_terminal_command|terminal|exec_command)$/i;

export function toolCall(name: string, input: unknown, flags: { isError?: boolean; rejected?: boolean } = {}): ToolCall {
  return {
    name: SHELL_TOOLS.test(name) ? "Bash" : name,
    summary: summarize(input),
    isError: !!flags.isError,
    rejected: !!flags.rejected,
  };
}

export const isoFromMs = (ms: unknown): string => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : typeof ms === "string" ? ms : "");
