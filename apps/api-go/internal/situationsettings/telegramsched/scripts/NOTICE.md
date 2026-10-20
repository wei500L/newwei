BullMQ Lua scripts (expanded)
=============================

Files in this directory:

  addJobScheduler-11.lua
  addStandardJob-9.lua
  removeJob-2.lua
  removeJobScheduler-3.lua
  removeRepeatable-3.lua

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

`addStandardJob-9.lua`, `removeJob-2.lua` and `removeRepeatable-3.lua` are the
same bytes the alert worker already vendors
(`internal/alertworker/queue/scripts/`). `addJobScheduler-11.lua` and
`removeJobScheduler-3.lua` are the two JobScheduler commands this batch needs in
addition to the already vendored `updateJobScheduler-12.lua` (used by the alert
worker for `{override:false}` rescheduling).

Mapping from BullMQ command name (and script version) to file name:

  addJobScheduler:11         -> addJobScheduler-11.lua
  addStandardJob:9           -> addStandardJob-9.lua
  removeJob:2                -> removeJob-2.lua
  removeJobScheduler:3       -> removeJobScheduler-3.lua
  removeRepeatable:3         -> removeRepeatable-3.lua

SHA-256 (bytes of the `.lua` file in this directory):

  76ef53583f09baeb53599e1b49f61317e3dc195c149721cbd86a02e72a3cfad3  addJobScheduler-11.lua
  9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e  addStandardJob-9.lua
  8eb5cf906f29e65df42e30580ce416eb18791b1684f9a8ced6d8c799f3f9ab7a  removeJob-2.lua
  98c40c2f329d9bad5499d23856fa3e8189df77cda8e92a8e97c66555497920b3  removeJobScheduler-3.lua
  482a7f1c8b6c9a101dbec680f36c65dbb37af71065bde67e04028cee18c906cf  removeRepeatable-3.lua

The digests are pinned by `scripts.go` and `scheduler_test.go`. An accidental edit
or a partial vendoring fails the unit test instead of silently changing the
shared `bull:situationMonitorSignals:*` state.

Key layout
----------

The queue name is `situationMonitorSignals` and the prefix is BullMQ's default
`bull`, so every key is `bull:situationMonitorSignals:<suffix>`. The scheduler
id is `telegram-poll:scheduler`; its next iteration lives in the `repeat` zset
as a member and in the `repeat:<id>` hash, while the delayed iteration is the
job key `repeat:<id>:<millis>`. This is the BullMQ 5 JobScheduler layout, not
the older hashed repeat layout cleaned up by `removeRepeatable-3.lua`.

MessagePack
-----------

The scripts decode option arguments with `cmsgpack.unpack`. api-go packs those
arguments with `github.com/vmihailenco/msgpack/v5` using plain maps (the same
value shapes msgpackr's `{useRecords: false}` produces). Container headers need
not be byte-identical: Redis cmsgpack decodes either form to the same Lua table,
and the scripts read by key.

Why the scripts are vendored
----------------------------

The NestJS `SituationMonitorSignalsModule` owns the same queue. A scheduler
upserted or removed by api-go must be indistinguishable from one handled by the
NestJS `Queue.upsertJobScheduler` / `Queue.removeJobScheduler` path, so Go
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
