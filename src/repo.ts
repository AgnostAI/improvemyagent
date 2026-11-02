import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { RepoFacts } from "./types.ts";
import { conductorRepoFor } from "./conductor.ts";

export interface RepoRef {
  /** Stable grouping key, e.g. "webapp". "~" for sessions outside any repo. */
  key: string;
  /** A path on disk where the repo currently lives, if any. */
  root?: string;
}

const cache = new Map<string, RepoRef>();

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

export function resolveRepo(cwd: string): RepoRef {
  if (!cwd) return { key: "~" };
  const hit = cache.get(cwd);
  if (hit) return hit;
  let ref: RepoRef;
  const home = homedir();
  // Conductor workspaces live at ~/conductor/workspaces/<repo>/<workspace>.
  const conductor = cwd.match(/\/conductor\/workspaces\/([^/]+)\/[^/]+/);
  if (cwd === home || cwd === "/private/tmp" || cwd === "/tmp") {
    ref = { key: "~" };
  } else if (conductor) {
    // Prefer the main checkout Conductor knows about over the (often archived) worktree.
    const main = conductorRepoFor(cwd);
    const key = main?.name ?? conductor[1];
    const candidates = [main?.root, join(home, "conductor", "repos", key), cwd].filter((p): p is string => !!p);
    const root = candidates.find((p) => existsSync(join(p, ".git")));
    ref = { key, root: root ? git(root, ["rev-parse", "--show-toplevel"]) ?? root : undefined };
  } else if (existsSync(cwd)) {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) {
      // Not a repo (e.g. Codex desktop chats in ~/Documents/Codex/...): personal scope.
      ref = { key: "~" };
    } else {
      const remote = git(top, ["remote", "get-url", "origin"]);
      ref = { key: remote ? basename(remote).replace(/\.git$/, "") : basename(top), root: top };
    }
  } else {
    ref = { key: basename(cwd) };
  }
  cache.set(cwd, ref);
  return ref;
}

const LOCKFILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "Cargo.lock": "cargo",
  "go.sum": "go",
};

export function repoFacts(root: string | undefined): RepoFacts {
  if (!root || !existsSync(root)) return { root: root ?? "", exists: false, lockfiles: [], scripts: {}, languages: [] };
  const lockfiles = Object.keys(LOCKFILES).filter((f) => existsSync(join(root, f)));
  let scripts: Record<string, string> = {};
  let packageManager: string | undefined;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      scripts = pkg.scripts ?? {};
      if (typeof pkg.packageManager === "string") packageManager = pkg.packageManager.split("@")[0];
    } catch {}
  }
  packageManager ??= lockfiles.map((f) => LOCKFILES[f]).find((m) => ["pnpm", "npm", "yarn", "bun"].includes(m));
  const languages: string[] = [];
  if (existsSync(pkgPath)) languages.push("javascript/typescript");
  if (["pyproject.toml", "requirements.txt", "setup.py"].some((f) => existsSync(join(root, f)))) languages.push("python");
  if (existsSync(join(root, "go.mod"))) languages.push("go");
  if (existsSync(join(root, "Cargo.toml"))) languages.push("rust");
  return { root, exists: true, packageManager, lockfiles, scripts, languages };
}

export function commitAt(root: string, iso: string): string | undefined {
  return git(root, ["rev-list", "-1", `--before=${iso}`, "HEAD"]);
}

