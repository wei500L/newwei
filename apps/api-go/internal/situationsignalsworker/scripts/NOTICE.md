BullMQ Lua scripts (expanded)
================================

Files in this directory (the subset of the BullMQ 5.63.2 state machine this
queue owns):

  addStandardJob-9.lua        oref bootstrap job (one-shot wait-list add)
  addDelayedJob-6.lua         next legacy repeat iteration
  addRepeatableJob-2.lua      legacy repeat zset member + hash
  moveToActive-11.lua         claim + lock + delayed promotion
  moveToFinished-14.lua       complete / fail
  moveToDelayed-8.lua         retry with backoff delay
  extendLock-2.lua            lock renewal
  moveStalledJobsToWait-8.lua stalled recovery
  retryJob-11.lua             immediate retry
  updateJobScheduler-12.lua   next JobScheduler / hashed-repeat iteration

Origin
------

Copied verbatim from the copies already vendored in this repository for the
version locked in `pnpm-lock.yaml` (bullmq 5.63.2):

  apps/api-go/internal/alertworker/queue/scripts/

Those files are the fully expanded commands of the published package
(`dist/cjs/commands/*.lua`, i.e. the same scripts as
https://cdn.jsdelivr.net/npm/bullmq@5.63.2/dist/cjs/scripts/<name>.js). No
script is downloaded or generated at runtime. BullMQ is MIT licensed.

SHA-256 (bytes of the `.lua` file in this directory):

  9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e  addStandardJob-9.lua
  b2994e8e08c9d6c140978d0b3ac2b6d965c005d8dfb006b1e5cb85b06fdb9cfb  addDelayedJob-6.lua
  53249b4e9adc4934ac2ee99bf946832f5a2623dfbe26e73de54465d86dc53470  addRepeatableJob-2.lua
  ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117  moveToActive-11.lua
  572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3  moveToFinished-14.lua
  3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7  moveToDelayed-8.lua
  f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2  extendLock-2.lua
  c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e  moveStalledJobsToWait-8.lua
  5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe  retryJob-11.lua
  09bc293d2ccf3cc493c12d59b39b43e449ced9b640d7693fe5f294316423a562  updateJobScheduler-12.lua

The same digests are asserted by queue_test.go, so a future edit that is not an
upstream change fails the unit test.

MessagePack
-----------

The scripts decode the job-options argument with `cmsgpack.unpack`, so api-go
packs that argument with the same MessagePack types BullMQ uses
(msgpackr with `useRecords: false`, undefined as nil): plain maps, arrays,
strings, booleans, numbers and nil. `github.com/vmihailenco/msgpack/v5` is
already a module dependency (it is also used by
internal/situationsettings/telegramsched), so no new dependency is added.

Why the scripts are vendored
----------------------------

The Go worker must stay wire-compatible with the NestJS BullMQ producer and
consumer while the queue switch is rolled out: both implementations have to
write and read the same `bull:situationMonitorSignals:*` state with the same
atomic state transitions.
