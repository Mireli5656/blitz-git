// BLITZ: loose object store.
// Objects are zlib-compressed and stored at objects/ab/cdef... exactly like Git.

import {
  hashObject,
  encodeObject,
  decodeObject,
  serializeTree,
  parseTree,
  serializeCommit,
  parseCommit,
} from "./objects.js";

// "deflate" in the Compression Streams API is the zlib format, which is
// what Git uses for loose objects. (No compression level knob is exposed.)
async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function deflate(bytes) {
  return pipe(bytes, new CompressionStream("deflate"));
}

export function inflate(bytes) {
  return pipe(bytes, new DecompressionStream("deflate"));
}

// ------------------------------------------------------------------- backends
// A backend is any object with: has(path), get(path) -> Uint8Array|null,
// put(path, bytes). All async.

export class MemoryBackend {
  constructor() {
    this.files = new Map();
  }
  async has(path) {
    return this.files.has(path);
  }
  async get(path) {
    return this.files.get(path) ?? null;
  }
  async put(path, bytes) {
    this.files.set(path, bytes);
  }
}

// Origin Private File System. Simple async version for Stage 1; Stage 5 moves
// this into Web Workers with synchronous access handles.
export class OpfsBackend {
  constructor(name = "blitz") {
    this.name = name;
    this._rootHandle = null;
  }

  async _root() {
    if (!this._rootHandle) {
      const top = await navigator.storage.getDirectory();
      this._rootHandle = await top.getDirectoryHandle(this.name, { create: true });
    }
    return this._rootHandle;
  }

  async _file(path, create) {
    const parts = path.split("/");
    const name = parts.pop();
    let dir = await this._root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(name, { create });
  }

  async has(path) {
    try {
      await this._file(path, false);
      return true;
    } catch (e) {
      if (e.name === "NotFoundError") return false;
      throw e;
    }
  }

  async get(path) {
    try {
      const handle = await this._file(path, false);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (e) {
      if (e.name === "NotFoundError") return null;
      throw e;
    }
  }

  async put(path, bytes) {
    const handle = await this._file(path, true);
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }
}

// ----------------------------------------------------------------- the store

export function objectPath(id) {
  return `objects/${id.slice(0, 2)}/${id.slice(2)}`;
}

export class ObjectStore {
  constructor(backend) {
    this.backend = backend;
  }

  has(id) {
    return this.backend.has(objectPath(id));
  }

  // Returns the object id. Skips the write if the object already exists.
  async write(type, content) {
    const id = hashObject(type, content);
    const path = objectPath(id);
    if (await this.backend.has(path)) return id;
    await this.backend.put(path, await deflate(encodeObject(type, content)));
    return id;
  }

  // Returns { type, content }. Pass { verify: true } to re-hash and compare.
  async read(id, { verify = false } = {}) {
    const stored = await this.backend.get(objectPath(id));
    if (!stored) throw new Error(`Object not found: ${id}`);
    const { type, content } = decodeObject(await inflate(stored));
    if (verify && hashObject(type, content) !== id) {
      throw new Error(`Object ${id} is corrupt (hash mismatch)`);
    }
    return { type, content };
  }

  writeBlob(content) {
    return this.write("blob", content);
  }

  writeTree(entries) {
    return this.write("tree", serializeTree(entries));
  }

  writeCommit(commit) {
    return this.write("commit", serializeCommit(commit));
  }

  async readTree(id) {
    const { type, content } = await this.read(id);
    if (type !== "tree") throw new Error(`Object ${id} is a ${type}, not a tree`);
    return parseTree(content);
  }

  async readCommit(id) {
    const { type, content } = await this.read(id);
    if (type !== "commit") throw new Error(`Object ${id} is a ${type}, not a commit`);
    return parseCommit(content);
  }
}
