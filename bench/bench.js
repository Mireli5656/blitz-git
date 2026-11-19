// BLITZ benchmark harness.
// Method: warm-up runs are discarded, then the MEDIAN of N runs is reported.

import { sha1 } from "../src/sha1.js";
import { hashObject } from "../src/objects.js";
import { ObjectStore, MemoryBackend } from "../src/store.js";

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
// Stage 1 compares BLITZ internals against crypto.subtle to test the design
// assumption "pure JS wins on small inputs, subtle wins on big ones".
// The comparison with isomorphic-git is added in a later stage.

export function scenarios() {
  const small = makeBlobs(10_000, 64, 1);
  const medium = makeBlobs(1_000, 200, 2);
  const large = makeBlobs(1, 8 * 1024 * 1024, 3)[0];
  const storeBlobs = makeBlobs(1_000, 200, 4);

  return [
    {
      name: "SHA-1, 10,000 x 64 B: BLITZ pure JS",
      opts: { ops: small.length, bytes: small.length * 64 },
      fn: () => {
        for (let i = 0; i < small.length; i++) sha1(small[i]);
      },
    },
    {
      name: "SHA-1, 10,000 x 64 B: crypto.subtle (awaited one by one)",
      opts: { ops: small.length, bytes: small.length * 64 },
      fn: async () => {
        for (let i = 0; i < small.length; i++) await crypto.subtle.digest("SHA-1", small[i]);
      },
    },
    {
      name: "SHA-1, 10,000 x 64 B: crypto.subtle (Promise.all)",
      opts: { ops: small.length, bytes: small.length * 64 },
      fn: () => Promise.all(small.map((b) => crypto.subtle.digest("SHA-1", b))),
    },
    {
      name: "SHA-1, 1 x 8 MB: BLITZ pure JS",
      opts: { ops: 1, bytes: large.length },
      fn: () => {
        sha1(large);
      },
    },
    {
      name: "SHA-1, 1 x 8 MB: crypto.subtle",
      opts: { ops: 1, bytes: large.length },
      fn: () => crypto.subtle.digest("SHA-1", large),
    },
    {
      name: "Git blob ids, 1,000 x 200 B (hashObject)",
      opts: { ops: medium.length, bytes: medium.length * 200 },
      fn: () => {
        for (let i = 0; i < medium.length; i++) hashObject("blob", medium[i]);
      },
    },
    {
      name: "ObjectStore.write, 1,000 x 200 B blobs (memory backend)",
      opts: { ops: storeBlobs.length, bytes: storeBlobs.length * 200 },
      fn: async () => {
        const store = new ObjectStore(new MemoryBackend()); // fresh store: no dedupe hits
        for (let i = 0; i < storeBlobs.length; i++) await store.writeBlob(storeBlobs[i]);
      },
    },
  ];
}

export function environment() {
  return {
    date: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "node",
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null,
    blitzStage: 1,
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
