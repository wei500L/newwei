package assistantqueue

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// luaScripts maps the assistant queue command names onto the single copies in
// internal/bullmq. The producer and the worker reference these values instead of
// vendoring their own Lua bodies.
var luaScripts = map[string]*redis.Script{
	"addStandardJob":        bullmq.ScriptAddStandardJob,
	"moveToActive":          bullmq.ScriptMoveToActive,
	"extendLock":            bullmq.ScriptExtendLock,
	"moveToFinished":        bullmq.ScriptMoveToFinished,
	"retryJob":              bullmq.ScriptRetryJob,
	"moveToDelayed":         bullmq.ScriptMoveToDelayed,
	"moveStalledJobsToWait": bullmq.ScriptMoveStalledJobsToWait,
	"removeJob":             bullmq.ScriptRemoveJob,
}

// luaScript returns the shared script for a command name.
func luaScript(name string) *redis.Script {
	return luaScripts[name]
}
