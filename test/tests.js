// BLITZ tests. Runs in the browser (test/index.html) and in Node 18+.

import { Sha1, sha1Hex, toHex, fromHex } from "../src/sha1.js";
import {
  hashObject,
  hashBlob,
  encodeObject,
  decodeObject,
  serializeTree,
  parseTree,
  serializeCommit,
  parseCommit,
} from "../src/objects.js";
import { ObjectStore, MemoryBackend, objectPath } from "../src/store.js";

const enc = new TextEncoder();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, label = "") {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

function randomBytes(n, seed) {
  let s = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

// ----------------------------------------------------------------------- SHA-1

test("sha1: empty input", () => {
  eq(sha1Hex(new Uint8Array(0)), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

test("sha1: abc", () => {
  eq(sha1Hex(enc.encode("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
});

test("sha1: two-block vector", () => {
  const msg = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  eq(sha1Hex(enc.encode(msg)), "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
});

test("sha1: one million 'a'", () => {
  const data = new Uint8Array(1_000_000).fill(97);
  eq(sha1Hex(data), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
});

test("sha1: matches crypto.subtle for lengths 0..300", async () => {
  for (let n = 0; n <= 300; n++) {
    const data = randomBytes(n, n + 1);
    const expected = toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", data)));
    eq(sha1Hex(data), expected, `length ${n}:`);
  }
});

test("sha1: incremental update equals one-shot", () => {
  const data = randomBytes(1000, 42);
  const whole = sha1Hex(data);
  for (const step of [1, 7, 63, 64, 65, 200]) {
    const h = new Sha1();
    for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
    eq(toHex(h.digest()), whole, `step ${step}:`);
  }
});

test("hex: round trip", () => {
  const bytes = randomBytes(20, 7);
  eq(toHex(fromHex(toHex(bytes))), toHex(bytes));
});

// --------------------------------------------------------------------- objects

test("blob ids match Git", () => {
  eq(hashBlob(enc.encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  eq(hashBlob(new Uint8Array(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("empty tree id matches Git", () => {
  eq(hashObject("tree", serializeTree([])), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("encode/decode object round trip", () => {
  const content = randomBytes(500, 3);
  const decoded = decodeObject(encodeObject("blob", content));
  eq(decoded.type, "blob");
  eq(toHex(decoded.content), toHex(content));
});

test("decode rejects wrong size", () => {
  const raw = enc.encode("blob 5\0abc");
  let failed = false;
  try {
    decodeObject(raw);
  } catch {
    failed = true;
  }
  eq(failed, true, "should throw:");
});

test("tree: Git sort order (directory sorts as name + '/')", () => {
  const id = "ce013625030ba8dba906f756967f9e9ca394464a";
  const tree = serializeTree([
    { mode: "40000", name: "foo", id },
    { mode: "100644", name: "foo.txt", id },
    { mode: "100644", name: "foo-bar", id },
  ]);
  const names = parseTree(tree).map((e) => e.name);
  eq(names.join(","), "foo-bar,foo.txt,foo");
});

test("tree: serialize/parse round trip", () => {
  const id = "ce013625030ba8dba906f756967f9e9ca394464a";
  const entries = [
    { mode: "100644", name: "a.txt", id },
    { mode: "100755", name: "run.sh", id },
    { mode: "40000", name: "src", id },
  ];
  const parsed = parseTree(serializeTree(entries));
  eq(JSON.stringify(parsed), JSON.stringify(entries));
});

test("commit: serialize/parse round trip", () => {
  const person = { name: "Mirali", email: "m@example.com", timestamp: 1700000000, tz: "+0400" };
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = parseCommit(
    serializeCommit({ tree, parents: ["ce013625030ba8dba906f756967f9e9ca394464a"], author: person, message: "Hello" }),
  );
  eq(commit.tree, tree);
  eq(commit.parents.length, 1);
  eq(commit.author.name, "Mirali");
  eq(commit.committer.timestamp, 1700000000);
  eq(commit.message, "Hello\n");
});

// ----------------------------------------------------------------------- store

test("store: write/read round trip with dedupe", async () => {
  const backend = new MemoryBackend();
  const store = new ObjectStore(backend);
  const content = enc.encode("hello\n");
  const id = await store.writeBlob(content);
  eq(id, "ce013625030ba8dba906f756967f9e9ca394464a");
  eq(await store.has(id), true, "has:");
  const again = await store.writeBlob(content);
  eq(again, id);
  eq(backend.files.size, 1, "files:");
  eq(backend.files.has(objectPath(id)), true, "path:");

  const read = await store.read(id, { verify: true });
  eq(read.type, "blob");
  eq(new TextDecoder().decode(read.content), "hello\n");
});

test("store: tree and commit round trip", async () => {
  const store = new ObjectStore(new MemoryBackend());
  const blobId = await store.writeBlob(enc.encode("data"));
  const treeId = await store.writeTree([{ mode: "100644", name: "file.txt", id: blobId }]);
  const person = { name: "A", email: "a@b.c", timestamp: 1700000000, tz: "+0000" };
  const commitId = await store.writeCommit({ tree: treeId, author: person, message: "init" });

  const entries = await store.readTree(treeId);
  eq(entries[0].name, "file.txt");
  const commit = await store.readCommit(commitId);
  eq(commit.tree, treeId);
});

test("store: missing object throws", async () => {
  const store = new ObjectStore(new MemoryBackend());
  let failed = false;
  try {
    await store.read("0".repeat(40));
  } catch {
    failed = true;
  }
  eq(failed, true, "should throw:");
});

// ---------------------------------------------------------------------- runner

export async function runAll(onResult = () => {}) {
  const results = [];
  for (const { name, fn } of tests) {
    const t0 = performance.now();
    let result;
    try {
      await fn();
      result = { name, ok: true, ms: performance.now() - t0 };
    } catch (error) {
      result = { name, ok: false, ms: performance.now() - t0, error: String(error.message || error) };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}
