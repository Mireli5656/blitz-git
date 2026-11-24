// BLITZ benchmark harness.
// Method: warm-up runs are discarded, then the MEDIAN of N runs is reported.
// Every scenario states its own run count (shown in the results table).

import { Sha1, sha1, toHex } from "../src/sha1.js";
import { hashObject, hashBlob } from "../src/objects.js";
import { ObjectStore, MemoryBackend } from "../src/store.js";
import { Index } from "../src/index-cache.js";
import { MemoryWorkTree } from "../src/worktree.js";
import { computeStatus } from "../src/status.js";

// ---------------------------------------------------------------------- utils

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

// Deterministic, unique pseudo-random blobs.
export function makeBlobs(count, size, seed = 1) {
  const next = rng(seed);
  const blobs = new Array(count);
  for (let i = 0; i < count; i++) {
    const b = new Uint8Array(size);
    for (let j = 0; j < size; j++) b[j] = next() & 255;
    blobs[i] = b;
  }
  return blobs;
}

export async function measure(name, fn, { runs = 11, warmup = 2, ops = 0, bytes = 0 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[times.length >> 1];
  const seconds = medianMs / 1000;
  return {
    name,
    runs,
    medianMs,
    minMs: times[0],
    maxMs: times[times.length - 1],
    opsPerSec: ops ? ops / seconds : null,
    mbPerSec: bytes ? bytes / 1048576 / seconds : null,
  };
}

// ------------------------------------------------------------------ scenarios
// Stage 1-2 compare BLITZ internals against crypto.subtle and against its own
// no-cache baseline. The comparison with isomorphic-git comes in a later stage.

const KB = 1024;
const MB = 1024 * KB;

export function scenarios() {
  const list = [];
  const add = (name, opts, fn) => list.push({ name, opts, fn });

  // ---- SHA-1: small vs large (Stage 1)
  const small = makeBlobs(10_000, 64, 1);
  const large = makeBlobs(1, 8 * MB, 3)[0];
  const smallOpts = { ops: small.length, bytes: small.length * 64 };

  add("SHA-1, 10,000 x 64 B: BLITZ pure JS", smallOpts, () => {
    for (let i = 0; i < small.length; i++) sha1(small[i]);
  });
  add("SHA-1, 10,000 x 64 B: crypto.subtle (awaited one by one)", smallOpts, async () => {
    for (let i = 0; i < small.length; i++) await crypto.subtle.digest("SHA-1", small[i]);
  });
  add("SHA-1, 10,000 x 64 B: crypto.subtle (Promise.all)", smallOpts, () =>
    Promise.all(small.map((b) => crypto.subtle.digest("SHA-1", b))),
  );
  add("SHA-1, 1 x 8 MB: BLITZ pure JS", { ops: 1, bytes: large.length }, () => {
    sha1(large);
  });
  add("SHA-1, 1 x 8 MB: crypto.subtle", { ops: 1, bytes: large.length }, () =>
    crypto.subtle.digest("SHA-1", large),
  );

  // ---- hashObject breakdown: where does the time go? (1,000 x 200 B)
  const medium = makeBlobs(1_000, 200, 2);
  const mediumOpts = { ops: medium.length, bytes: medium.length * 200 };
  const encoder = new TextEncoder();
  const hasher = new Sha1();
  const digest20 = new Uint8Array(20);

  add("hashObject part: SHA-1 only, 1,000 x 200 B (no header)", mediumOpts, () => {
    for (let i = 0; i < medium.length; i++) hasher.reset().update(medium[i]).digest();
  });
  add("hashObject part: header encode (TextEncoder), 1,000x", { ops: 1000 }, () => {
    for (let i = 0; i < 1000; i++) encoder.encode(`blob ${medium[i].length}\0`);
  });
  add("hashObject part: toHex(20 bytes), 1,000x", { ops: 1000 }, () => {
    for (let i = 0; i < 1000; i++) toHex(digest20);
  });
  add("hashObject total: Git blob ids, 1,000 x 200 B", mediumOpts, () => {
    for (let i = 0; i < medium.length; i++) hashObject("blob", medium[i]);
  });

  // ---- SHA-1 crossover sweep: where does crypto.subtle start to win?
  // Each size hashes 1 MB in total, so only the per-call overhead differs.
  const pool = makeBlobs(1, MB, 5)[0];
  for (const [label, size] of [["256 B", 256], ["1 KB", KB], ["4 KB", 4 * KB], ["16 KB", 16 * KB], ["64 KB", 64 * KB], ["256 KB", 256 * KB]]) {
    const count = MB / size;
    const parts = Array.from({ length: count }, (_, i) => pool.subarray(i * size, (i + 1) * size));
    const opts = { runs: 7, ops: count, bytes: MB };
    add(`SHA-1 sweep ${label} (1 MB total): BLITZ pure JS`, opts, () => {
      for (let i = 0; i < parts.length; i++) sha1(parts[i]);
    });
    add(`SHA-1 sweep ${label} (1 MB total): crypto.subtle`, opts, async () => {
      for (let i = 0; i < parts.length; i++) await crypto.subtle.digest("SHA-1", parts[i]);
    });
  }

  // ---- status on 10,000 files (Stage 2). Stat-cache effect with an in-memory
  // work tree; real OPFS adds a getFile() cost per file (measured in Stage 5).
  const N = 10_000;
  const BASE = 1_700_000_000_000;
  const treeBlobs = makeBlobs(N, 200, 6);
  const clean = new MemoryWorkTree();
  const dirty = new MemoryWorkTree();
  const index = new Index();
  for (let i = 0; i < N; i++) {
    const path = `dir${i % 100}/file${i}.txt`;
    clean.write(path, treeBlobs[i], { mtimeMs: BASE + i });
    index.set({ path, id: hashBlob(treeBlobs[i]), size: 200, mtimeMs: BASE + i, mode: 0o100644 });
    if (i % 100 === 0) {
      const changed = treeBlobs[i].slice();
      changed[0] ^= 1;
      dirty.write(path, changed, { mtimeMs: BASE + i + 1 });
    } else {
      dirty.write(path, treeBlobs[i], { mtimeMs: BASE + i });
    }
  }
  const expect = (cond, msg) => {
    if (!cond) throw new Error(`benchmark self-check failed: ${msg}`);
  };

  add("status, 10,000 files, nothing changed (stat cache)", { ops: N }, async () => {
    const r = await computeStatus(index, clean);
    expect(r.counters.rehashed === 0 && r.modified.length === 0, "cache should skip every file");
  });
  add("status, 10,000 files, 100 modified (stat cache)", { ops: N }, async () => {
    const r = await computeStatus(index, dirty);
    expect(r.counters.rehashed === 100 && r.modified.length === 100, "only the 100 changed files");
  });
  add("status, 10,000 files, no stat cache (rehash all)", { ops: N, bytes: N * 200 }, async () => {
    const r = await computeStatus(index, clean, { trustStat: false });
    expect(r.counters.rehashed === N && r.modified.length === 0, "every file should be hashed");
  });

  // ---- object store write (slowest, so it runs last)
  const storeBlobs = makeBlobs(500, 200, 4);
  add("ObjectStore.write, 500 x 200 B blobs (memory backend)", { ops: storeBlobs.length, bytes: storeBlobs.length * 200 }, async () => {
    const store = new ObjectStore(new MemoryBackend()); // fresh store: no dedupe hits
    for (let i = 0; i < storeBlobs.length; i++) await store.writeBlob(storeBlobs[i]);
  });

  return list;
}

export function environment() {
  return {
    date: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "node",
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null,
    blitzStage: 2,
  };
}

export async function runAll({ runs = 11, onProgress = () => {}, onResult = () => {} } = {}) {
  const list = scenarios();
  const results = [];
  for (let i = 0; i < list.length; i++) {
    onProgress(i, list.length, list[i].name);
    const r = await measure(list[i].name, list[i].fn, { runs, ...list[i].opts });
    results.push(r);
    onResult(r);
  }
  return { environment: environment(), results };
}
