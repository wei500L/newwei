// Package bullmq is the single Go implementation of the BullMQ 5.63.2 Redis
// wire protocol used by apps/api-go.
//
// It owns three things that used to be copied into every queue package:
//
//   - the vendored Lua commands in scripts/, embedded once through go:embed and
//     exported as *redis.Script values (ScriptAddStandardJob, ScriptMoveToActive,
//     ...). Each file is named <command>-<numberOfKeys>.lua; see NOTICE for the
//     provenance and licence.
//   - the queue key layout (Keys/NewKeys) and the read-only job decoder
//     (ReadJob/ReadJobLogs/Job/StoredOptions) shared by the queue operations
//     console and the organization queue statistics tracker.
//   - a producer Queue (NewQueue/Queue.Add) that packs the msgpack argument tuple
//     and the job options exactly like BullMQ's Scripts.addJob and dispatches to
//     the standard, delayed or prioritized add command.
//
// Workers that run the consumer state machine keep their own loop; they consume
// the exported Script* values here instead of embedding a second copy of each
// Lua file.
package bullmq
