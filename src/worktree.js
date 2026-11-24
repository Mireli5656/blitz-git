// BLITZ: work tree backends (the folder of files you edit).
//
// A work tree is any object with:
//   list()        -> [{ path, size, mtimeMs, mode }]   (stat only, no content)
//   stat(path)    -> { size, mtimeMs, mode } | null
//   read(path)    -> Uint8Array
// Paths always use "/" and are relative to the root.

const encoder = new TextEncoder();
const FILE_MODE = 0o100644; // browsers cannot see the executable bit

const toBytes = (content) => (typeof content === "string" ? encoder.encode(content) : content);

// ------------------------------------------------------------------ in memory
// Used by tests and benchmarks: no I/O, fully deterministic mtimes.

export class MemoryWorkTree {
  constructor() {
    this.files = new Map();
  }

  write(path, content, { mtimeMs = Date.now(), mode = FILE_MODE } = {}) {
    this.files.set(path, { content: toBytes(content), mtimeMs, mode });
  }

  touch(path, mtimeMs) {
    this.files.get(path).mtimeMs = mtimeMs;
  }

  remove(path) {
    this.files.delete(path);
  }

  async list() {
    const out = [];
    for (const [path, f] of this.files) {
      out.push({ path, size: f.content.length, mtimeMs: f.mtimeMs, mode: f.mode });
    }
    return out;
  }

  async stat(path) {
    const f = this.files.get(path);
    return f ? { size: f.content.length, mtimeMs: f.mtimeMs, mode: f.mode } : null;
  }

  async read(path) {
    const f = this.files.get(path);
    if (!f) throw new Error(`No such file: ${path}`);
    return f.content;
  }
}

// ------------------------------------------------------- directory handle (OPFS)
// Works with any FileSystemDirectoryHandle: the Origin Private File System
// (navigator.storage.getDirectory()) or a folder from showDirectoryPicker().

export class FsHandleWorkTree {
  constructor(root, { ignore = [".git", ".blitz"] } = {}) {
    this.root = root;
    this.ignore = new Set(ignore);
  }

  // Directories are walked in parallel; each file costs one getFile() call.
  async list() {
    const out = [];
    await this._walk(this.root, "", out);
    return out;
  }

  async _walk(dir, prefix, out) {
    const jobs = [];
    for await (const [name, handle] of dir.entries()) {
      if (this.ignore.has(name)) continue;
      if (handle.kind === "directory") {
        jobs.push(this._walk(handle, `${prefix}${name}/`, out));
      } else {
        jobs.push(
          handle.getFile().then((file) => {
            out.push({ path: prefix + name, size: file.size, mtimeMs: file.lastModified, mode: FILE_MODE });
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  async _handle(path, create) {
    const parts = path.split("/");
    const name = parts.pop();
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(name, { create });
  }

  async stat(path) {
    try {
      const file = await (await this._handle(path, false)).getFile();
      return { size: file.size, mtimeMs: file.lastModified, mode: FILE_MODE };
    } catch (e) {
      if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null;
      throw e;
    }
  }

  async read(path) {
    const file = await (await this._handle(path, false)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path, content) {
    const handle = await this._handle(path, true);
    const writable = await handle.createWritable();
    await writable.write(toBytes(content));
    await writable.close();
  }

  async remove(path) {
    const parts = path.split("/");
    const name = parts.pop();
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(name);
  }
}
