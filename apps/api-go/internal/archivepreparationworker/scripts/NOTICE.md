# BullMQ Lua scripts

These files are the official Lua commands required by the limited
`news_event_clustering_recovery` queue runner in
`apps/api-go/internal/clusteringrecoveryqueue`. They are embedded at build
time (`go:embed`); the process never downloads a script at runtime.

- Upstream: `bullmq@5.63.2` (the version locked by `pnpm-lock.yaml`)
- Source: https://github.com/taskforcesh/bullmq/tree/v5.63.2/src/commands
- License: MIT, Copyright (c) 2018 BullForce Labs AB (see below)
- Expansion: each committed file is the exact `content` string produced by
  BullMQ's `ScriptLoader` for the npm `dist/esm/scripts` build: `@include`
  directives are inlined once in dependency order and empty lines are removed.
  The Go runner passes these strings to `EVAL`/`EVALSHA` unchanged.

| Script | Upstream raw SHA-256 | Expanded SHA-256 (committed file) |
|---|---|---|
| `addStandardJob-9.lua` | `e0168c7a343f66ba4703a8296f4e388f9a8f984a19e882a658d1981962e1e742` | `9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e` |
| `moveToActive-11.lua` | `fd27e12203000d2bcbe59b7e7c44f3f6acf7fe3ec63dd92dae1e0a69f2d4a004` | `ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117` |
| `extendLock-2.lua` | `ccb26c4f390625a882819335f1d6077455b9a633e99527028e0f1910b2c1db3f` | `f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2` |
| `moveToFinished-14.lua` | `8fac037ff3dd5b7ef16e94817ec93a7e6dcccdc729f11d65d86c5efc41390b7f` | `572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3` |
| `retryJob-11.lua` | `fe9558b56d8a0f64fbd13e196a6bc07534ec800a0972e49f45433e31fe47ba3d` | `5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe` |
| `moveStalledJobsToWait-8.lua` | `0ccb155a535dee4fce8bad8b3a9ef0c7665bd8be329ff7e9cf1e655dbf845515` | `c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e` |

The `-N` suffix in each filename is the BullMQ `numberOfKeys` value: the first
N arguments of each `EVAL` call are `KEYS`, the remainder are `ARGV`.

## MIT License

Copyright (c) 2018 BullForce Labs AB.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
