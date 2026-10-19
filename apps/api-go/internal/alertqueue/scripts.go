package alertqueue

import (
	_ "embed"

	"github.com/redis/go-redis/v9"
)

// The Lua scripts below are copied byte-for-byte from the locked BullMQ 5.63.2
// package (node_modules/.pnpm/bullmq@5.63.2/node_modules/bullmq/dist/cjs/
// scripts/*.js, the `content` field after include expansion). They are run
// unchanged so the Redis writes are indistinguishable from the ones the
// NestJS Queue client performs.
//
// The scripts are MIT licensed; see NOTICE in this directory.
//
// Script/ARGS contract (identical to classes/scripts.js):
//   - addStandardJob-9: KEYS[1..9] wait, paused, meta, id, completed, delayed,
//     active, events, marker; ARGV[1] msgpack(args), ARGV[2] job data JSON,
//     ARGV[3] msgpack(opts).
//   - addDelayedJob-6: KEYS[1..6] marker, meta, id, delayed, completed,
//     events; same ARGV shape.
//   - addRepeatableJob-2: KEYS[1..2] repeat, delayed; ARGV[1] nextMillis,
//     ARGV[2] msgpack(repeat opts), ARGV[3] legacy concat key, ARGV[4] repeat
//     key, ARGV[5] key prefix.
//   - removeRepeatable-3: KEYS[1..3] repeat, delayed, events; ARGV[1] legacy
//     repeat job id, ARGV[2] legacy concat options, ARGV[3] repeat key,
//     ARGV[4] key prefix.
//   - removeJob-2: KEYS[1..2] job key, repeat key; ARGV[1] job id,
//     ARGV[2] removeChildren, ARGV[3] key prefix.

//go:embed scripts/addStandardJob-9.lua
var addStandardJobSource string

//go:embed scripts/addDelayedJob-6.lua
var addDelayedJobSource string

//go:embed scripts/addRepeatableJob-2.lua
var addRepeatableJobSource string

//go:embed scripts/removeRepeatable-3.lua
var removeRepeatableSource string

//go:embed scripts/removeJob-2.lua
var removeJobSource string

// redis.NewScript computes the SHA1 used by EVALSHA and falls back to EVAL on
// NOSCRIPT, so a cold API host never needs a separate script load.
var (
	addStandardJobScript   = redis.NewScript(addStandardJobSource)
	addDelayedJobScript    = redis.NewScript(addDelayedJobSource)
	addRepeatableJobScript = redis.NewScript(addRepeatableJobSource)
	removeRepeatableScript = redis.NewScript(removeRepeatableSource)
	removeJobScript        = redis.NewScript(removeJobSource)
)
