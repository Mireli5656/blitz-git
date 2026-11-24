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
import { ObjectStore, MemoryBackend, OpfsBackend, objectPath } from "../src/store.js";
import { Index } from "../src/index-cache.js";
import { MemoryWorkTree, FsHandleWorkTree } from "../src/worktree.js";
import { computeStatus } from "../src/status.js";
import { Repo } from "../src/repo.js";

const enc = new TextEncoder();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class Skip extends Error {}
const skip = (reason) => {
  throw new Skip(reason);
};

async function rejects(fn, text = "") {
  try {
    await fn();
  } catch (e) {
    if (!String(e.message).includes(text)) throw new Error(`wrong error: ${e.message}`);
    return;
  }
  throw new Error("expected an error, but none was thrown");
}

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

// ----------------------------------------------------------------------- index

const ID = "ce013625030ba8dba906f756967f9e9ca394464a";
const OLD = 1_000_000_000_000; // an mtime far in the past: never racy

function sampleIndex() {
  const idx = new Index();
  const paths = ["a", "ab", "abc", "dir/file.txt", "dir/sub/deep.js", "x".repeat(61), "y".repeat(62), "z".repeat(70), "ünï/файл.txt"];
  paths.forEach((path, i) => {
    idx.set({ path, id: ID, size: i * 10 + 1, mtimeMs: 1_700_000_000_000 + i * 1000 + 123, mode: 0o100644 });
  });
  return idx;
}

test("index: serialize/parse round trip (padding, unicode, long paths)", () => {
  const idx = sampleIndex();
  const parsed = Index.parse(idx.serialize({ nowMs: 1_800_000_000_000 }));
  eq(parsed.size, idx.size, "size:");
  for (const e of idx.values()) {
    const p = parsed.get(e.path);
    eq(JSON.stringify(p), JSON.stringify(e), `entry ${e.path.slice(0, 12)}:`);
  }
});

test("index: entries are written in Git path order", () => {
  const idx = new Index();
  for (const path of ["a/b.txt", "a.txt", "a-1"]) {
    idx.set({ path, id: ID, size: 1, mtimeMs: OLD, mode: 0o100644 });
  }
  const parsed = Index.parse(idx.serialize({ nowMs: OLD + 100_000 }));
  eq([...parsed.entries.keys()].join(","), "a-1,a.txt,a/b.txt");
});

test("index: racy entries are smudged (size 0), old entries are not", () => {
  const now = 1_800_000_000_000;
  const idx = new Index();
  idx.set({ path: "old", id: ID, size: 5, mtimeMs: OLD, mode: 0o100644 });
  idx.set({ path: "fresh", id: ID, size: 7, mtimeMs: now - 500, mode: 0o100644 });
  const parsed = Index.parse(idx.serialize({ nowMs: now }));
  eq(parsed.get("old").size, 5, "old:");
  eq(parsed.get("fresh").size, 0, "fresh:");
  eq(idx.get("fresh").size, 7, "in-memory copy untouched:");
});

test("index: corruption and unsupported versions are rejected", async () => {
  const bytes = sampleIndex().serialize({ nowMs: 1_800_000_000_000 });
  const flipped = bytes.slice();
  flipped[40] ^= 1;
  await rejects(() => Index.parse(flipped), "checksum");
  await rejects(() => Index.parse(bytes.subarray(0, 20)), "too short");

  const v3 = bytes.slice();
  new DataView(v3.buffer).setUint32(4, 3);
  v3.set(new Sha1().update(v3.subarray(0, v3.length - 20)).digest(), v3.length - 20);
  await rejects(() => Index.parse(v3), "version");
});

// ---------------------------------------------------------------------- status

async function newRepo() {
  const worktree = new MemoryWorkTree();
  const backend = new MemoryBackend();
  const repo = await Repo.open({ backend, worktree });
  return { repo, worktree, backend };
}

const summary = (s) => JSON.stringify([s.modified, s.deleted, s.untracked]);

test("status: untracked, then clean after add, with zero rehashing", async () => {
  const { repo, worktree } = await newRepo();
  worktree.write("a.txt", "hello\n", { mtimeMs: OLD });
  worktree.write("dir/b.txt", "world\n", { mtimeMs: OLD });
  let s = await repo.status();
  eq(s.untracked.join(","), "a.txt,dir/b.txt");
  await repo.add(["a.txt", "dir/b.txt"]);
  s = await repo.status();
  eq(summary(s), "[[],[],[]]");
  eq(s.counters.rehashed, 0, "rehashed:");
  eq(s.counters.scanned, 2, "scanned:");
});

test("status: modified (same size, new mtime) and deleted", async () => {
  const { repo, worktree } = await newRepo();
  worktree.write("a.txt", "hello\n", { mtimeMs: OLD });
  worktree.write("b.txt", "world\n", { mtimeMs: OLD });
  await repo.add(["a.txt", "b.txt"]);
  worktree.write("a.txt", "HELLO\n", { mtimeMs: OLD + 5000 });
  worktree.remove("b.txt");
  const s = await repo.status();
  eq(summary(s), '[["a.txt"],["b.txt"],[]]');
  eq(s.counters.rehashed, 1, "rehashed:");
});

test("status: touch without change is refreshed once, then cached", async () => {
  const { repo, worktree } = await newRepo();
  worktree.write("a.txt", "hello\n", { mtimeMs: OLD });
  await repo.add("a.txt");
  worktree.touch("a.txt", OLD + 5000);
  let s = await repo.status();
  eq(summary(s), "[[],[],[]]");
  eq(s.counters.rehashed, 1, "first rehashed:");
  eq(s.counters.refreshed, 1, "first refreshed:");
  s = await repo.status();
  eq(s.counters.rehashed, 0, "second rehashed:");
});

test("status: trustStat=false rehashes every tracked file", async () => {
  const { repo, worktree } = await newRepo();
  for (let i = 0; i < 5; i++) worktree.write(`f${i}.txt`, `content ${i}`, { mtimeMs: OLD });
  await repo.add(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
  const s = await computeStatus(repo.index, worktree, { trustStat: false });
  eq(s.counters.rehashed, 5, "rehashed:");
  eq(summary(s), "[[],[],[]]");
});

test("status: racy change (same size, same mtime) is detected, also after reload", async () => {
  const { repo, worktree, backend } = await newRepo();
  const now = Date.now();
  worktree.write("r.txt", "aaaa", { mtimeMs: now });
  await repo.add("r.txt");
  worktree.write("r.txt", "bbbb", { mtimeMs: now }); // identical size and mtime
  let s = await repo.status();
  eq(s.modified.join(","), "r.txt", "in memory:");
  const reopened = await Repo.open({ backend, worktree });
  s = await reopened.status();
  eq(s.modified.join(","), "r.txt", "after reload:");
});

test("repo.add: errors, and removal of deleted tracked files", async () => {
  const { repo, worktree } = await newRepo();
  await rejects(() => repo.add("missing.txt"), "did not match");
  await rejects(() => repo.add("../escape.txt"), "Invalid path");
  await rejects(() => repo.add(".git/config"), "Invalid path");
  worktree.write("a.txt", "x", { mtimeMs: OLD });
  await repo.add("a.txt");
  worktree.remove("a.txt");
  await repo.add("a.txt");
  eq(repo.index.size, 0, "index size:");
});

test("repo: index survives a reload and stays fast", async () => {
  const { repo, worktree, backend } = await newRepo();
  worktree.write("a.txt", "hello\n", { mtimeMs: OLD });
  await repo.add("a.txt");
  const reopened = await Repo.open({ backend, worktree });
  const s = await reopened.status();
  eq(summary(s), "[[],[],[]]");
  eq(s.counters.rehashed, 0, "rehashed:");
});

// ------------------------------------------------- directory handles (fake + real)

class NotFound extends Error {
  constructor(name) {
    super(`Not found: ${name}`);
    this.name = "NotFoundError";
  }
}

class FakeFile {
  constructor() {
    this.kind = "file";
    this.data = new Uint8Array(0);
    this.lastModified = Date.now();
  }
  async getFile() {
    const data = this.data;
    return { size: data.length, lastModified: this.lastModified, arrayBuffer: async () => data.slice().buffer };
  }
  async createWritable() {
    const self = this;
    const chunks = [];
    return {
      write: async (d) => chunks.push(typeof d === "string" ? enc.encode(d) : d),
      close: async () => {
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        self.data = out;
        self.lastModified = Date.now();
      },
    };
  }
}

// Minimal in-memory stand-in for FileSystemDirectoryHandle (same method names).
class FakeDir {
  constructor() {
    this.kind = "directory";
    this.children = new Map();
  }
  async *entries() {
    for (const pair of this.children) yield pair;
  }
  _get(name, create, make, kind) {
    let h = this.children.get(name);
    if (!h) {
      if (!create) throw new NotFound(name);
      h = make();
      this.children.set(name, h);
    }
    if (h.kind !== kind) {
      const e = new Error("type mismatch");
      e.name = "TypeMismatchError";
      throw e;
    }
    return h;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    return this._get(name, create, () => new FakeDir(), "directory");
  }
  async getFileHandle(name, { create = false } = {}) {
    return this._get(name, create, () => new FakeFile(), "file");
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new NotFound(name);
  }
}

test("FsHandleWorkTree: write, list, stat, read, remove (fake handles)", async () => {
  const wt = new FsHandleWorkTree(new FakeDir());
  await wt.write("src/lib/a.js", "x");
  await wt.write("b.txt", "yy");
  await wt.write(".git/config", "ignored");
  const files = (await wt.list()).sort((p, q) => (p.path < q.path ? -1 : 1));
  eq(files.map((f) => `${f.path}:${f.size}`).join(","), "b.txt:2,src/lib/a.js:1");
  eq(new TextDecoder().decode(await wt.read("src/lib/a.js")), "x");
  eq((await wt.stat("b.txt")).size, 2, "stat size:");
  eq(await wt.stat("nope/none.txt"), null, "stat missing:");
  await wt.remove("b.txt");
  eq((await wt.list()).length, 1, "after remove:");
});

test("repo: add and status over directory handles (fake)", async () => {
  const worktree = new FsHandleWorkTree(new FakeDir());
  const backend = new MemoryBackend();
  await worktree.write("index.html", "<h1>hi</h1>");
  await worktree.write("css/site.css", "body{}");
  const repo = await Repo.open({ backend, worktree });
  await repo.add(["index.html", "css/site.css"]);
  await worktree.write("index.html", "<h1>HI</h1>");
  const s = await repo.status();
  eq(summary(s), '[["index.html"],[],[]]');
});

test("OpfsBackend: object store round trip (fake parent handle)", async () => {
  const store = new ObjectStore(new OpfsBackend("blitz", new FakeDir()));
  eq(await store.has("0".repeat(40)), false, "has missing:");
  const id = await store.writeBlob(enc.encode("hello\n"));
  eq(id, "ce013625030ba8dba906f756967f9e9ca394464a");
  eq(await store.has(id), true, "has:");
  eq(new TextDecoder().decode((await store.read(id, { verify: true })).content), "hello\n");
});

test("real OPFS: store + work tree round trip (browser only)", async () => {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.getDirectory) {
    skip("OPFS is not available in this environment");
  }
  const top = await navigator.storage.getDirectory();
  const name = `blitz-test-${Date.now()}`;
  try {
    const store = new ObjectStore(new OpfsBackend(name));
    const id = await store.writeBlob(enc.encode("opfs works\n"));
    eq(new TextDecoder().decode((await store.read(id, { verify: true })).content), "opfs works\n");

    const dir = await top.getDirectoryHandle(name);
    const wt = new FsHandleWorkTree(await dir.getDirectoryHandle("tree", { create: true }));
    await wt.write("x/y.txt", "hi");
    const files = await wt.list();
    eq(files.map((f) => f.path).join(","), "x/y.txt", "list:");
    eq(new TextDecoder().decode(await wt.read("x/y.txt")), "hi", "read:");
  } finally {
    await top.removeEntry(name, { recursive: true });
  }
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
      result =
        error instanceof Skip
          ? { name, ok: true, skipped: true, note: error.message, ms: performance.now() - t0 }
          : { name, ok: false, ms: performance.now() - t0, error: String(error.message || error) };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}
