// Package economicqueue implements the small BullMQ 5.63.2 producer and worker
// surface that the economic-data migration needs.
//
// It is intentionally not a general BullMQ client. The Redis hash layout,
// repeat ZSET/member names, delayed-score packing, FIFO wait list and repeat
// key derivation are transcribed from bullmq@5.63.2 (MIT, Taskforce.sh Inc.),
// the version pinned by pnpm-lock.yaml. Lua scripts used here are the same
// sliding/promotion operations the Node worker performs, with the cmsgpack
// argument marshalling replaced by direct Redis commands because all persisted
// job fields are JSON strings.
//
// Queue keys use the default `bull` prefix: bull:akshare-data:*.
package economicqueue
