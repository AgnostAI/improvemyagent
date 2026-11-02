// Read-only access to other apps' SQLite files (Conductor, Cursor) via node:sqlite.
import { existsSync } from "node:fs";

type Db = { prepare(sql: string): { all(...params: unknown[]): any[] }; close(): void };

let DatabaseSync: (new (path: string, opts: { readOnly: boolean }) => Db) | undefined;
try {
  // Loaded lazily so older Node versions still run everything else.
  ({ DatabaseSync } = await import("node:sqlite") as any);
} catch {}

export function openReadOnly(path: string): Db | undefined {
  if (!DatabaseSync || !existsSync(path)) return undefined;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}

export function query<T = any>(db: Db, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}
