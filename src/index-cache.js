// BLITZ: the index (staging area + stat cache) in real Git "DIRC" version 2 format.
//
// Each entry remembers a file's size and mtime. If both still match, status can
// skip reading the file entirely. That is where most of the speed comes from.
//
// Browsers do not expose ctime, dev, ino, uid or gid, so those are written as
// zero (ctime = mtime). Real Git reads the file fine and simply re-checks
// content once, which refreshes its own stat data.

import { Sha1, toHex, fromHex } from "./sha1.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Entries modified this close to the time the index was written cannot be
// trusted on stat alone (the file may change again within the same timestamp
// tick). Generous on purpose: some file systems only keep 2 s resolution.
export const RACY_WINDOW_MS = 2000;

const HEADER_SIZE = 12;
const ENTRY_FIXED = 62;
const SIGNATURE = 0x44495243; // "DIRC"

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

const entrySize = (nameLength) => (ENTRY_FIXED + nameLength + 8) & ~7;

// An entry: { path, id (40 hex), size, mtimeMs, mode (number, e.g. 0o100644) }
export class Index {
  constructor() {
    this.entries = new Map();
    // When this index was last written (ms). null = unknown (freshly parsed;
    // racy entries were already smudged on disk).
    this.timestampMs = null;
  }

  get size() {
    return this.entries.size;
  }
  has(path) {
    return this.entries.has(path);
  }
  get(path) {
    return this.entries.get(path);
  }
  delete(path) {
    return this.entries.delete(path);
  }
  values() {
    return this.entries.values();
  }

  set(entry) {
    if (!/^[0-9a-f]{40}$/.test(entry.id)) throw new Error(`Invalid object id: ${entry.id}`);
    this.entries.set(entry.path, entry);
    return this;
  }

  // Returns the index file bytes. Entries whose mtime is within RACY_WINDOW_MS
  // of nowMs are written with size 0 ("smudged"), so that after a reload the
  // size can never match and the content is re-checked. Same trick as Git.
  serialize({ nowMs = Date.now() } = {}) {
    const items = [];
    for (const e of this.entries.values()) items.push({ e, name: encoder.encode(e.path) });
    items.sort((a, b) => compareBytes(a.name, b.name));

    let total = HEADER_SIZE;
    for (const it of items) total += entrySize(it.name.length);
    const out = new Uint8Array(total + 20);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIGNATURE);
    dv.setUint32(4, 2);
    dv.setUint32(8, items.length);

    const racyFrom = nowMs - RACY_WINDOW_MS;
    let o = HEADER_SIZE;
    for (const { e, name } of items) {
      const sec = Math.floor(e.mtimeMs / 1000);
      const nsec = Math.min(999_999_999, Math.round((e.mtimeMs - sec * 1000) * 1e6));
      const size = e.mtimeMs >= racyFrom && e.size !== 0 ? 0 : e.size >>> 0;
      dv.setUint32(o, sec); // ctime (= mtime)
      dv.setUint32(o + 4, nsec);
      dv.setUint32(o + 8, sec); // mtime
      dv.setUint32(o + 12, nsec);
      // dev, ino (o+16, o+20) stay 0
      dv.setUint32(o + 24, e.mode);
      // uid, gid (o+28, o+32) stay 0
      dv.setUint32(o + 36, size);
      fromHex(e.id, out, o + 40);
      dv.setUint16(o + 60, Math.min(name.length, 0xfff));
      out.set(name, o + ENTRY_FIXED);
      o += entrySize(name.length); // padding bytes are already zero
    }

    out.set(new Sha1().update(out.subarray(0, o)).digest(), o);
    this.timestampMs = nowMs;
    return out;
  }

  static parse(bytes) {
    if (bytes.length < HEADER_SIZE + 20) throw new Error("Corrupt index: too short");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0) !== SIGNATURE) throw new Error("Corrupt index: bad signature");
    const version = dv.getUint32(4);
    if (version !== 2) throw new Error(`Unsupported index version ${version} (BLITZ reads version 2)`);

    const end = bytes.length - 20;
    const sum = new Sha1().update(bytes.subarray(0, end)).digest();
    for (let i = 0; i < 20; i++) {
      if (sum[i] !== bytes[end + i]) throw new Error("Corrupt index: checksum mismatch");
    }

    const count = dv.getUint32(8);
    const index = new Index();
    let o = HEADER_SIZE;
    for (let n = 0; n < count; n++) {
      if (o + ENTRY_FIXED >= end) throw new Error("Corrupt index: truncated entry");
      const flags = dv.getUint16(o + 60);
      if (flags & 0x4000) throw new Error("Unsupported index entry (extended flags)");
      if (flags & 0x3000) throw new Error("Unsupported index (unmerged entries)");

      const nameStart = o + ENTRY_FIXED;
      let nameLength = flags & 0xfff;
      if (nameLength === 0xfff) {
        const nul = bytes.indexOf(0, nameStart);
        if (nul < 0 || nul >= end) throw new Error("Corrupt index: unterminated path");
        nameLength = nul - nameStart;
      }
      if (nameStart + nameLength >= end) throw new Error("Corrupt index: truncated path");

      const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      index.entries.set(path, {
        path,
        id: toHex(bytes.subarray(o + 40, o + 60)),
        size: dv.getUint32(o + 36),
        mtimeMs: dv.getUint32(o + 8) * 1000 + dv.getUint32(o + 12) / 1e6,
        mode: dv.getUint32(o + 24),
      });
      o += entrySize(nameLength);
    }

    // What remains before the checksum are extensions (4-byte name, 4-byte size).
    // Optional ones (uppercase first letter) are skipped; required ones are not supported.
    while (o < end) {
      if (o + 8 > end) throw new Error("Corrupt index: truncated extension");
      const first = bytes[o];
      if (first >= 0x61 && first <= 0x7a) {
        throw new Error(`Unsupported required index extension "${decoder.decode(bytes.subarray(o, o + 4))}"`);
      }
      o += 8 + dv.getUint32(o + 4);
      if (o > end) throw new Error("Corrupt index: extension overruns file");
    }
    return index;
  }
}
