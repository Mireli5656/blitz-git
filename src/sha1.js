// BLITZ: pure-JS SHA-1 (incremental, allocation-free hot path).
//
// Why not crypto.subtle only? subtle.digest is async, so every call pays
// promise + thread-hop overhead. For the small objects that dominate Git
// repos, a tight synchronous loop wins. For big inputs subtle takes over
// (see bench/). Not reentrant across awaits: use one Sha1 per worker/task.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

export function fromHex(hex, out = new Uint8Array(hex.length >> 1), offset = 0) {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  for (let i = 0; i < hex.length; i += 2) {
    out[offset + (i >> 1)] = parseInt(hex.substr(i, 2), 16);
  }
  return out;
}

export class Sha1 {
  constructor() {
    this._h = new Int32Array(5);
    this._w = new Int32Array(80);
    this._buf = new Uint8Array(64);
    this.reset();
  }

  reset() {
    const h = this._h;
    h[0] = 0x67452301;
    h[1] = 0xefcdab89;
    h[2] = 0x98badcfe;
    h[3] = 0x10325476;
    h[4] = 0xc3d2e1f0;
    this._len = 0; // bytes waiting in _buf
    this._total = 0; // total bytes hashed
    return this;
  }

  // data: Uint8Array. Returns this, so calls can be chained.
  update(data) {
    const n = data.length;
    this._total += n;
    let i = 0;

    if (this._len > 0) {
      const take = Math.min(64 - this._len, n);
      this._buf.set(data.subarray(0, take), this._len);
      this._len += take;
      i = take;
      if (this._len === 64) {
        this._block(this._buf, 0);
        this._len = 0;
      }
    }

    for (; i + 64 <= n; i += 64) this._block(data, i);

    if (i < n) {
      this._buf.set(data.subarray(i), 0);
      this._len = n - i;
    }
    return this;
  }

  // Finalizes and returns the 20-byte digest. Call reset() before reuse.
  digest() {
    const buf = this._buf;
    let n = this._len;
    buf[n++] = 0x80;
    if (n > 56) {
      buf.fill(0, n, 64);
      this._block(buf, 0);
      n = 0;
    }
    buf.fill(0, n, 56);

    const hi = Math.floor(this._total / 0x20000000); // bits >> 32
    const lo = (this._total * 8) >>> 0; // bits & 0xffffffff
    buf[56] = hi >>> 24;
    buf[57] = hi >>> 16;
    buf[58] = hi >>> 8;
    buf[59] = hi;
    buf[60] = lo >>> 24;
    buf[61] = lo >>> 16;
    buf[62] = lo >>> 8;
    buf[63] = lo;
    this._block(buf, 0);

    const out = new Uint8Array(20);
    const h = this._h;
    for (let i = 0; i < 5; i++) {
      out[i * 4] = h[i] >>> 24;
      out[i * 4 + 1] = h[i] >>> 16;
      out[i * 4 + 2] = h[i] >>> 8;
      out[i * 4 + 3] = h[i];
    }
    return out;
  }

  _block(b, o) {
    const w = this._w;
    const h = this._h;

    for (let t = 0; t < 16; t++, o += 4) {
      w[t] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    }
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }

    let a = h[0];
    let bb = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let tmp;

    for (let t = 0; t < 20; t++) {
      tmp = (((a << 5) | (a >>> 27)) + ((bb & c) | (~bb & d)) + e + 0x5a827999 + w[t]) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = tmp;
    }
    for (let t = 20; t < 40; t++) {
      tmp = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + e + 0x6ed9eba1 + w[t]) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = tmp;
    }
    for (let t = 40; t < 60; t++) {
      tmp = (((a << 5) | (a >>> 27)) + ((bb & c) | (bb & d) | (c & d)) + e + 0x8f1bbcdc + w[t]) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = tmp;
    }
    for (let t = 60; t < 80; t++) {
      tmp = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + e + 0xca62c1d6 + w[t]) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = tmp;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + bb) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }
}

// One-shot helpers. They share one hasher, so they are synchronous-only.
const shared = new Sha1();

export function sha1(data) {
  return shared.reset().update(data).digest();
}

export function sha1Hex(data) {
  return toHex(sha1(data));
}
