// Package economicqueue implements the small BullMQ 5.63.2 producer and worker
// surface that the economic-data migration needs.
//
// It is intentionally not a general BullMQ client. The producer keeps the
// historical hash/repeat layout of the akshare-data queue (see producer.go),
// while the worker state machine uses the official BullMQ 5.63.2 Lua commands
// vendored in scripts/: moveToActive (paused-aware claim, lock acquisition and
// delayed promotion), extendLock (lock renewal), moveToFinished (completed/
// failed with keepJobs retention), moveStalledJobsToWait (lock-based stalled
// recovery) and addStandardJob (paused-aware manual enqueue).
//
// The Redis hash layout, repeat ZSET/member names, delayed-score packing, FIFO
// wait list and repeat key derivation are transcribed from bullmq@5.63.2 (MIT,
// Taskforce.sh Inc.), the version pinned by pnpm-lock.yaml. Queue keys use the
// default `bull` prefix: bull:akshare-data:*.
package economicqueue
