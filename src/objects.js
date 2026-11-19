// BLITZ: Git object format (blob, tree, commit).
// Everything here is byte-compatible with regular Git.

import { Sha1, toHex, fromHex } from "./sha1.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hasher = new Sha1(); // sync-only, see sha1.js

export const TYPES = ["blob", "tree", "commit", "tag"];
const HEX40 = /^[0-9a-f]{40}$/;
const DIR_MODE = "40000";

function header(type, size) {
  return encoder.encode(`${type} ${size}\0`);
}

// ---------------------------------------------------------------- raw objects

// Object id = SHA-1 of "<type> <size>\0<content>". No concatenation copy.
export function hashObject(type, content) {
  return toHex(hasher.reset().update(header(type, content.length)).update(content).digest());
}

export function hashBlob(content) {
  return hashObject("blob", content);
}

// Full raw form (header + content), as stored inside a loose object.
export function encodeObject(type, content) {
  const h = header(type, content.length);
  const out = new Uint8Array(h.length + content.length);
  out.set(h, 0);
  out.set(content, h.length);
  return out;
}

export function decodeObject(raw) {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("Corrupt object: missing header terminator");
  const parts = decoder.decode(raw.subarray(0, nul)).split(" ");
  const [type, sizeText] = parts;
  if (parts.length !== 2 || !TYPES.includes(type) || !/^\d+$/.test(sizeText)) {
    throw new Error("Corrupt object: bad header");
  }
  const content = raw.subarray(nul + 1);
  if (content.length !== Number(sizeText)) {
    throw new Error(`Corrupt object: expected ${sizeText} bytes, got ${content.length}`);
  }
  return { type, content };
}

// ----------------------------------------------------------------------- tree

function normalizeMode(mode) {
  const m = String(mode).replace(/^0+/, ""); // "040000" -> "40000"
  if (!/^[0-7]{5,6}$/.test(m)) throw new Error(`Invalid mode: ${mode}`);
  return m;
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// entries: [{ mode, name, id }]. Sorted the way Git sorts them:
// bytewise by name, where directories compare as if their name ended in "/".
export function serializeTree(entries) {
  const items = entries.map((e) => {
    const mode = normalizeMode(e.mode);
    if (!HEX40.test(e.id)) throw new Error(`Invalid object id: ${e.id}`);
    const name = encoder.encode(e.name);
    if (name.length === 0 || name.includes(0) || name.includes(47)) {
      throw new Error(`Invalid entry name: ${e.name}`);
    }
    let key = name;
    if (mode === DIR_MODE) {
      key = new Uint8Array(name.length + 1);
      key.set(name);
      key[name.length] = 47;
    }
    return { mode, id: e.id, name, key };
  });
  items.sort((x, y) => compareBytes(x.key, y.key));

  let size = 0;
  for (const it of items) size += it.mode.length + 1 + it.name.length + 1 + 20;
  const out = new Uint8Array(size);
  let o = 0;
  for (const it of items) {
    for (let i = 0; i < it.mode.length; i++) out[o++] = it.mode.charCodeAt(i);
    out[o++] = 32;
    out.set(it.name, o);
    o += it.name.length;
    out[o++] = 0;
    fromHex(it.id, out, o);
    o += 20;
  }
  return out;
}

export function parseTree(content) {
  const entries = [];
  let o = 0;
  while (o < content.length) {
    const sp = content.indexOf(32, o);
    const nul = sp < 0 ? -1 : content.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > content.length) {
      throw new Error("Corrupt tree object");
    }
    entries.push({
      mode: decoder.decode(content.subarray(o, sp)),
      name: decoder.decode(content.subarray(sp + 1, nul)),
      id: toHex(content.subarray(nul + 1, nul + 21)),
    });
    o = nul + 21;
  }
  return entries;
}

// --------------------------------------------------------------------- commit

// person: { name, email, timestamp (unix seconds), tz ("+0400") }
function formatPerson(p) {
  if (/[\n<>]/.test(p.name) || /[\n<>]/.test(p.email)) {
    throw new Error("Invalid author or committer");
  }
  if (!Number.isInteger(p.timestamp) || !/^[+-]\d{4}$/.test(p.tz)) {
    throw new Error("Invalid timestamp or timezone");
  }
  return `${p.name} <${p.email}> ${p.timestamp} ${p.tz}`;
}

function parsePerson(text) {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text ?? "");
  if (!m) throw new Error(`Corrupt person line: ${text}`);
  return { name: m[1], email: m[2], timestamp: Number(m[3]), tz: m[4] };
}

export function serializeCommit({ tree, parents = [], author, committer = author, message }) {
  for (const id of [tree, ...parents]) {
    if (!HEX40.test(id)) throw new Error(`Invalid object id: ${id}`);
  }
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${formatPerson(author)}\n`;
  text += `committer ${formatPerson(committer)}\n\n`;
  text += message.endsWith("\n") ? message : `${message}\n`;
  return encoder.encode(text);
}

export function parseCommit(content) {
  const text = decoder.decode(content);
  const split = text.indexOf("\n\n");
  const headText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2);

  const headers = [];
  for (const line of headText.split("\n")) {
    if (line.startsWith(" ") && headers.length) {
      headers[headers.length - 1][1] += `\n${line.slice(1)}`; // continuation line
    } else {
      const sp = line.indexOf(" ");
      headers.push(sp < 0 ? [line, ""] : [line.slice(0, sp), line.slice(sp + 1)]);
    }
  }
  const get = (key) => headers.find((h) => h[0] === key)?.[1];

  return {
    tree: get("tree"),
    parents: headers.filter((h) => h[0] === "parent").map((h) => h[1]),
    author: parsePerson(get("author")),
    committer: parsePerson(get("committer")),
    message,
    headers,
  };
}
