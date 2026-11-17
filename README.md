# BLITZ

**A browser-native Git implementation built for one thing: speed.**

BLITZ runs entirely in the browser with vanilla JavaScript. No dependencies, no build step, no server. It reads and writes the real Git object format, so what it creates stays compatible with regular Git.

> **Status:** early development. Nothing is benchmarked yet, and no speed claim in this project counts until it is backed by a public, reproducible benchmark.

---

## Goal

Be the **fastest Git implementation in JavaScript**, measured against [isomorphic-git](https://isomorphic-git.org) on the same machine, same data, same browser.

Native Git written in C will always have the edge on raw CPU work. BLITZ aims to win where JavaScript implementations are slow today: many small objects, large working trees and repeated `status` calls.

## Principles

- **Zero dependencies.** Plain ES modules, nothing to install.
- **No build tools.** What you read in the repo is what the browser runs.
- **Real Git format.** SHA-1 object IDs, loose objects, packfiles.
- **Measure first.** Every optimization needs a benchmark that proves it.
- **Runs anywhere a browser runs**, including phones.

## How it gets fast

| Area | Approach |
|---|---|
| Storage | Origin Private File System (OPFS) with sync access handles inside Web Workers |
| Hashing | Pure-JS SHA-1 for small objects, `crypto.subtle` for large ones (async overhead hurts small files) |
| Compression | Native `CompressionStream` (deflate) |
| Status | Git-style index cache (mtime + size), so unchanged files are never re-read |
| Parallelism | Worker pool for hashing and compression |
| Storage size | Packfiles with delta compression |

## Planned API

> Draft. The API may change before the first release.

```js
import { Repo } from "./src/repo.js";

const repo = await Repo.init("my-project");

await repo.add("index.html");
const id = await repo.commit("First commit");

console.log(await repo.status());
console.log(await repo.log());
```

## Roadmap

- [ ] **Stage 1:** Object store (blob, tree, commit), SHA-1, loose objects, benchmark harness
- [ ] **Stage 2:** Index file and cached `status`
- [ ] **Stage 3:** `add`, `commit`, `log`
- [ ] **Stage 4:** `branch`, `checkout`
- [ ] **Stage 5:** Worker pool and OPFS tuning
- [ ] **Stage 6:** Packfiles and delta compression
- [ ] **Stage 7:** `diff`
- [ ] **Stage 8:** `clone` and `fetch` over smart HTTP
- [ ] **Stage 9:** Public benchmark page and first release

## Benchmarks

Planned scenarios, each compared with isomorphic-git:

1. Hash and store 10,000 small files
2. `status` on an unchanged tree of 10,000 files
3. `add` and `commit` 1,000 changed files
4. `log` over 10,000 commits

**Method:** median of at least 10 runs, warm-up run discarded, browser and device model recorded with every result. Raw numbers and the benchmark code will live in `bench/`.

**Results:** none yet.

## Project structure (planned)

```
blitz-git/
├── index.html        # demo and benchmark UI
├── src/
│   ├── sha1.js       # hashing
│   ├── objects.js    # blob, tree, commit
│   ├── index-cache.js
│   ├── repo.js       # public API
│   └── worker.js     # worker pool
├── bench/            # benchmark code and results
└── README.md
```

## Hosting

Live demo and benchmark page via GitHub Pages: `https://mireli5656.github.io/blitz-git/`

## Contributing

Issues and pull requests are welcome. Performance changes must include before and after benchmark numbers.

## License

MIT
