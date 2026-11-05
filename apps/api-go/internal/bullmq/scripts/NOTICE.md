# BullMQ 5.63.2 Lua scripts (shared)

These files are the single copy of every BullMQ Lua command used by
`apps/api-go`. They are embedded at build time (`go:embed`) and exported from
`internal/bullmq` as `bullmq.Script*`; no script is downloaded at runtime.

- Upstream: `bullmq@5.63.2` (the version locked by `pnpm-lock.yaml`)
- Source: https://github.com/taskforcesh/bullmq/tree/v5.63.2/src/commands
- License: MIT, Copyright (c) 2018 BullForce Labs AB (see below)
- Expansion: each committed file is the exact `content` string produced by
  BullMQ's `ScriptLoader` for the npm `dist/esm/scripts` build: `@include`
  directives are inlined once in dependency order and empty lines are removed.
  The Go code passes these strings to `EVAL`/`EVALSHA` unchanged.
- Naming: `<command>-<numberOfKeys>.lua`; the suffix is the BullMQ
  `numberOfKeys` value (the first N arguments of each `EVAL` call are `KEYS`).

| Script | numberOfKeys | Committed SHA-256 |
|---|---|---|

| `addDelayedJob-6.lua` | 6 | `b2994e8e08c9d6c140978d0b3ac2b6d965c005d8dfb006b1e5cb85b06fdb9cfb` |
| `addJobScheduler-11.lua` | 11 | `76ef53583f09baeb53599e1b49f61317e3dc195c149721cbd86a02e72a3cfad3` |
| `addPrioritizedJob-9.lua` | 9 | `7dbb395410e784c536d282cea64658605a46ca080fa4290695c4937c304cc462` |
| `addRepeatableJob-2.lua` | 2 | `53249b4e9adc4934ac2ee99bf946832f5a2623dfbe26e73de54465d86dc53470` |
| `addStandardJob-9.lua` | 9 | `9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e` |
| `cleanJobsInSet-3.lua` | 3 | `d887256ebff3dfff48be717bb91c9dcd36b7ea022ee6b73d4667334b8676dd3c` |
| `extendLock-2.lua` | 2 | `f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2` |
| `getCounts-1.lua` | 1 | `8b92225a199eba16fbcf42c6bfcb6a17fdad7c490270cf06527ba5951b6862bf` |
| `getRanges-1.lua` | 1 | `242c9ed1ef9828b0b7548e41802a114c06934887612e01af0bd652fd900f7545` |
| `getStateV2-8.lua` | 8 | `c5b75f6296af0472df26bf288e913ee445d398b5ba8c7187a830760c7c01e093` |
| `moveJobFromActiveToWait-9.lua` | 9 | `5825f9ec905734a8647a8feef89dc2f4e84f7ad1ecb8497b0c2fc57b7d2ac592` |
| `moveStalledJobsToWait-8.lua` | 8 | `c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e` |
| `moveToActive-11.lua` | 11 | `ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117` |
| `moveToDelayed-8.lua` | 8 | `3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7` |
| `moveToFinished-14.lua` | 14 | `572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3` |
| `pause-7.lua` | 7 | `ef92926f5a206d2650b4c2fb15c1019f03f2f18e2351ff6a52fdccdc449bfc0d` |
| `promote-9.lua` | 9 | `893ac344e38c120309177e6b097cb7525cd98a77e2e676f84b3f020a75dabfeb` |
| `removeJob-2.lua` | 2 | `8eb5cf906f29e65df42e30580ce416eb18791b1684f9a8ced6d8c799f3f9ab7a` |
| `removeJobScheduler-3.lua` | 3 | `98c40c2f329d9bad5499d23856fa3e8189df77cda8e92a8e97c66555497920b3` |
| `removeRepeatable-3.lua` | 3 | `482a7f1c8b6c9a101dbec680f36c65dbb37af71065bde67e04028cee18c906cf` |
| `reprocessJob-8.lua` | 8 | `6a80ae54d0d310c0ac5c3dbdb17c070ae6f615a340c43f2b49e1c8869a50d4f6` |
| `retryJob-11.lua` | 11 | `5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe` |
| `updateData-1.lua` | 1 | `33dc385c7749b1c525495725afb5894ee96295c8f61336273496aaed04ed6b2f` |
| `updateJobScheduler-12.lua` | 12 | `09bc293d2ccf3cc493c12d59b39b43e449ced9b640d7693fe5f294316423a562` |
| `updateRepeat-4.lua` | 4 | `5e65283fbaf9961e9f0f04c573d51ebd517062d8862247967772993c65a63595` |

Some commands (`getStateV2`, `updateRepeat`, `addPrioritizedJob`) were previously
only present as Go string constants or inline scripts in individual packages;
they are vendored here from the same BullMQ 5.63.2 distribution.

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
