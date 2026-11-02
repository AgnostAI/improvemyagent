import { closeSync, openSync, readSync } from "node:fs";

/** Lines longer than this are almost always screenshots or huge tool outputs. */
const MAX_LINE = 4 * 1024 * 1024;

/**
 * Streams a JSONL file line by line without loading it into one string;
 * Codex rollouts can be several hundred MB.
 */
export function forEachJsonLine(path: string, cb: (ev: any) => void, skip?: (head: string) => boolean): void {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(1024 * 1024);
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false;
  const emit = (line: Buffer) => {
    if (!line.length) return;
    // Cheap pre-check on the first bytes so huge irrelevant lines are never parsed.
    if (skip && skip(line.subarray(0, 200).toString("utf8"))) return;
    try {
      cb(JSON.parse(line.toString("utf8")));
    } catch {}
  };
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let start = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, i + 1)) {
        if (!skipping) {
          const tail = buf.subarray(start, i);
          emit(partLen ? Buffer.concat([...parts, tail]) : tail);
        }
        parts = [];
        partLen = 0;
        skipping = false;
        start = i + 1;
      }
      if (start < n && !skipping) {
        parts.push(Buffer.from(buf.subarray(start, n)));
        partLen += n - start;
        if (partLen > MAX_LINE) {
          skipping = true;
          parts = [];
          partLen = 0;
        }
      }
    }
    if (partLen && !skipping) emit(Buffer.concat(parts));
  } finally {
    closeSync(fd);
  }
}
