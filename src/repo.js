// BLITZ: the Repo ties together the object store, the index and a work tree.
// Stage 2: add (files) and status. commit and log arrive in Stage 3.
//
// backend:  where objects and the index live (MemoryBackend, OpfsBackend, ...)
// worktree: the files being tracked (MemoryWorkTree, FsHandleWorkTree, ...)

import { ObjectStore } from "./store.js";
import { Index } from "./index-cache.js";
import { computeStatus } from "./status.js";

const INDEX_PATH = "index";

function checkPath(path) {
  const bad =
    typeof path !== "string" ||
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => p === "" || p === "." || p === ".." || p === ".git");
  if (bad) throw new Error(`Invalid path: ${path}`);
}

export class Repo {
  constructor({ backend, worktree }) {
    this.backend = backend;
    this.worktree = worktree;
    this.store = new ObjectStore(backend);
    this.index = new Index();
  }

  static async open(options) {
    const repo = new Repo(options);
    await repo.loadIndex();
    return repo;
  }

  async loadIndex() {
    const bytes = await this.backend.get(INDEX_PATH);
    this.index = bytes ? Index.parse(bytes) : new Index();
    return this.index;
  }

  async saveIndex(nowMs = Date.now()) {
    await this.backend.put(INDEX_PATH, this.index.serialize({ nowMs }));
  }

  // Stage one path or a list of paths (files only for now). A tracked path
  // that no longer exists in the work tree is removed from the index.
  async add(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    const plans = [];
    for (const path of list) {
      checkPath(path);
      const stat = await this.worktree.stat(path);
      if (stat) plans.push({ path, stat });
      else if (this.index.has(path)) plans.push({ path, remove: true });
      else throw new Error(`pathspec '${path}' did not match any files`);
    }

    for (const plan of plans) {
      if (plan.remove) {
        this.index.delete(plan.path);
        continue;
      }
      const content = await this.worktree.read(plan.path);
      const id = await this.store.writeBlob(content);
      this.index.set({
        path: plan.path,
        id,
        size: content.length,
        mtimeMs: plan.stat.mtimeMs,
        mode: plan.stat.mode,
      });
    }
    await this.saveIndex();
  }

  // { modified, deleted, untracked, counters }. Saves the index if the stat
  // cache was refreshed, so the next call is faster.
  async status() {
    const result = await computeStatus(this.index, this.worktree);
    if (result.counters.refreshed > 0) await this.saveIndex();
    return result;
  }
}
