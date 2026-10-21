// Package bullmqwire is the read-only BullMQ 5.63.2 job-hash decoder shared by
// the queue operations console (internal/queueops) and the organization queue
// statistics tracker (internal/queueorgstats).
//
// Both owners must read a job exactly the way BullMQ's Job.fromJSON does, or the
// console would show fields the worker never wrote and the tracker would derive
// retention flags from a different option shape. Keeping one decoder here means
// the two ports cannot drift apart.
//
// The package never writes Redis and owns no scripts: the console reaches the
// state-changing commands through the official vendored Lua scripts in
// internal/queueops/scripts, and the tracker applies the three Redis Lua scripts
// QueueOrgStatsService already owns. Provenance of the field layout is BullMQ
// 5.63.2 (dist/cjs/classes/job.js:173-215) and dist/cjs/commands/includes/
// storeJob.lua (name/data/opts/timestamp/delay/priority).
package bullmqwire
