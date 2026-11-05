package telegramsched

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// schedulerScripts holds the BullMQ 5.63.2 job-scheduler commands. They are the
// single shared copies embedded in internal/bullmq; this package no longer
// vendors its own.
type schedulerScripts struct {
	addJobScheduler    *redis.Script
	addStandardJob     *redis.Script
	removeJob          *redis.Script
	removeJobScheduler *redis.Script
	removeRepeatable   *redis.Script
}

func loadScripts() (schedulerScripts, error) {
	return schedulerScripts{
		addJobScheduler:    bullmq.ScriptAddJobScheduler,
		addStandardJob:     bullmq.ScriptAddStandardJob,
		removeJob:          bullmq.ScriptRemoveJob,
		removeJobScheduler: bullmq.ScriptRemoveJobScheduler,
		removeRepeatable:   bullmq.ScriptRemoveRepeatable,
	}, nil
}
