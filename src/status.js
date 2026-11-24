// BLITZ: status = index vs work tree.
//
// Fast path: if a tracked file still has the same size and mtime as its index
// entry (and the entry is not "racy"), it is unchanged and is never read.
// Only files whose stat differs are read and hashed.
//
// Result: { modified, deleted, untracked, counters }
//   counters.scanned   files listed in the work tree
//   counters.rehashed  files whose content had to be read and hashed
//   counters.refreshed files whose stat changed but content did not (the index
//                      entry is updated in memory so the next status is fast)

import { hashBlob } from "./objects.js";
import { RACY_WINDOW_MS } from "./index-cache.js";

const CONCURRENCY = 32;

// trustStat: false disables the cache (rehash everything). Used as a baseline in benchmarks.
export async function computeStatus(index, worktree, { trustStat = true } = {}) {
  const files = await worktree.list();
  const counters = { scanned: files.length, rehashed: 0, refreshed: 0 };

  const untracked = [];
  const modified = [];
  const deleted = [];
  const pending = [];
  let trackedFound = 0;

  // Entries modified shortly before the index was written are not trusted on stat alone.
  const racyFrom = index.timestampMs == null ? Infinity : index.timestampMs - RACY_WINDOW_MS;

  for (const f of files) {
    const entry = index.get(f.path);
    if (!entry) {
      untracked.push(f.path);
      continue;
    }
    trackedFound++;
    const statMatches = f.size === entry.size && Math.floor(f.mtimeMs) === Math.floor(entry.mtimeMs);
    if (trustStat && statMatches && entry.mtimeMs < racyFrom) continue;
    pending.push({ path: f.path, mtimeMs: f.mtimeMs, entry, statMatches });
  }

  if (trackedFound !== index.size) {
    const present = new Set(files.map((f) => f.path));
    for (const path of index.entries.keys()) {
      if (!present.has(path)) deleted.push(path);
    }
  }

  async function check({ path, mtimeMs, entry, statMatches }) {
    const content = await worktree.read(path);
    counters.rehashed++;
    if (hashBlob(content) !== entry.id) {
      modified.push(path);
    } else if (!statMatches) {
      entry.size = content.length; // same content, new stat: refresh the cache
      entry.mtimeMs = mtimeMs;
      counters.refreshed++;
    }
  }

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    await Promise.all(pending.slice(i, i + CONCURRENCY).map(check));
  }

  modified.sort();
  deleted.sort();
  untracked.sort();
  return { modified, deleted, untracked, counters };
}
