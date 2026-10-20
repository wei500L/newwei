BullMQ Lua scripts (expanded)
================================

Files in this directory:

  addStandardJob-9.lua
  addDelayedJob-6.lua
  addRepeatableJob-2.lua
  removeRepeatable-3.lua
  removeJob-2.lua
  moveToActive-11.lua
  moveToFinished-14.lua
  moveToDelayed-8.lua
  extendLock-2.lua
  moveStalledJobsToWait-8.lua
  retryJob-11.lua
  updateData-1.lua
  updateJobScheduler-12.lua

Origin
------

Copied from the BullMQ version this repository locks in `pnpm-lock.yaml`
(bullmq 5.63.2), from the published package:

  https://cdn.jsdelivr.net/npm/bullmq@5.63.2/dist/cjs/scripts/<name>.js

Each of those modules embeds the fully expanded script (the `--- @include`
directives of `dist/cjs/commands/*.lua` already resolved) as the `content`
template literal. The files here are that embedded content copied verbatim, so
the includes and the function ordering are exactly what BullMQ 5.63.2 executes
against Redis. No script is downloaded or generated at runtime.

Mapping from BullMQ command name (and script version) to file name:

  addStandardJob:9           -> addStandardJob-9.lua
  addDelayedJob:6            -> addDelayedJob-6.lua
  addRepeatableJob:2         -> addRepeatableJob-2.lua
  removeRepeatable:3         -> removeRepeatable-3.lua
  removeJob:2                -> removeJob-2.lua
  moveToActive:11            -> moveToActive-11.lua
  moveToFinished:14          -> moveToFinished-14.lua
  moveToDelayed:8            -> moveToDelayed-8.lua
  extendLock:2               -> extendLock-2.lua
  moveStalledJobsToWait:8    -> moveStalledJobsToWait-8.lua
  retryJob:11                -> retryJob-11.lua
  updateData:1               -> updateData-1.lua
  updateJobScheduler:12      -> updateJobScheduler-12.lua

SHA-256 (bytes of the `.lua` file in this directory):

  9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e  addStandardJob-9.lua
  b2994e8e08c9d6c140978d0b3ac2b6d965c005d8dfb006b1e5cb85b06fdb9cfb  addDelayedJob-6.lua
  53249b4e9adc4934ac2ee99bf946832f5a2623dfbe26e73de54465d86dc53470  addRepeatableJob-2.lua
  482a7f1c8b6c9a101dbec680f36c65dbb37af71065bde67e04028cee18c906cf  removeRepeatable-3.lua
  8eb5cf906f29e65df42e30580ce416eb18791b1684f9a8ced6d8c799f3f9ab7a  removeJob-2.lua
  ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117  moveToActive-11.lua
  572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3  moveToFinished-14.lua
  3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7  moveToDelayed-8.lua
  f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2  extendLock-2.lua
  c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e  moveStalledJobsToWait-8.lua
  5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe  retryJob-11.lua
  33dc385c7749b1c525495725afb5894ee96295c8f61336273496aaed04ed6b2f  updateData-1.lua
  09bc293d2ccf3cc493c12d59b39b43e449ced9b640d7693fe5f294316423a562  updateJobScheduler-12.lua

The same digests are asserted by scripts_test.go, so a future edit that is not
an upstream change fails the unit test.

MessagePack
-----------

The scripts decode the job-options argument with `cmsgpack.unpack`, so api-go
packs that argument with the same MessagePack profile BullMQ uses
(`msgpackr.Packr({useRecords: false, encodeUndefinedAsNil: true})`): plain maps,
arrays, strings, integers, booleans, float64 and nil. `internal/alertworker/queue/msgpack.go`
implements that minimal encoder locally instead of adding a dependency, and
`msgpack_test.go` pins the byte-level encoding.

Why the scripts are vendored
----------------------------

api-go and NestJS share the `alerts` queue. A job added, delayed, retried or
finished by Go must be indistinguishable from one handled by BullMQ, so Go
executes the same Lua state machine against Redis instead of re-implementing it.

BullMQ is distributed under the MIT license:

  MIT License

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
