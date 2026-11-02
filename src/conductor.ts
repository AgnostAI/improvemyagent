// Conductor runs Claude Code / Codex inside throwaway git worktrees
// (~/conductor/workspaces/<repo>/<name>). Its database knows the real repo
// each workspace belongs to, so rules land in the main checkout instead.
import { homedir } from "node:os";
import { join } from "node:path";
import { openReadOnly, query } from "./sqlite.ts";

export interface ConductorRepo {
  name: string;
  root: string;
  prompts: Record<string, string>;
}

interface Data {
  byWorkspace: Map<string, ConductorRepo>;
  byName: Map<string, ConductorRepo>;
}

let cached: Data | undefined;

function dbPath(): string {
  return process.env.IMA_CONDUCTOR_DB ?? join(homedir(), "Library", "Application Support", "com.conductor.app", "conductor.db");
}

export function conductor(): Data {
  if (cached) return cached;
  cached = { byWorkspace: new Map(), byName: new Map() };
  const db = openReadOnly(dbPath());
  if (!db) return cached;
  try {
    const repos = query(db, "SELECT * FROM repos");
    const byId = new Map<string, ConductorRepo>();
    for (const r of repos) {
      if (!r.root_path) continue;
      const prompts: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) if (k.startsWith("custom_prompt_") && typeof v === "string" && v.trim()) prompts[k.slice(14)] = v;
      const repo = { name: r.name, root: r.root_path, prompts };
      byId.set(String(r.id), repo);
      cached.byName.set(r.name, repo);
    }
    for (const w of query(db, "SELECT repository_id, workspace_path FROM workspaces WHERE workspace_path IS NOT NULL")) {
      const repo = byId.get(String(w.repository_id));
      if (repo) cached.byWorkspace.set(w.workspace_path, repo);
    }
  } finally {
    db.close();
  }
  return cached;
}

/** The main repo for a Conductor workspace cwd, if Conductor knows it. */
export function conductorRepoFor(cwd: string): ConductorRepo | undefined {
  const c = conductor();
  for (const [path, repo] of c.byWorkspace) if (cwd === path || cwd.startsWith(path + "/")) return repo;
  const name = cwd.match(/\/conductor\/workspaces\/([^/]+)\//)?.[1];
  return name ? c.byName.get(name) : undefined;
}
