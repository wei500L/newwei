package analysisqueue

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueScripts is the BullMQ command set of one queue worker. The scripts are
// the shared copies in internal/bullmq; this package no longer vendors its own.
type queueScripts struct {
	addStandardJob        *redis.Script
	moveToActive          *redis.Script
	extendLock            *redis.Script
	moveToFinished        *redis.Script
	retryJob              *redis.Script
	moveStalledJobsToWait *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		addStandardJob:        bullmq.ScriptAddStandardJob,
		moveToActive:          bullmq.ScriptMoveToActive,
		extendLock:            bullmq.ScriptExtendLock,
		moveToFinished:        bullmq.ScriptMoveToFinished,
		retryJob:              bullmq.ScriptRetryJob,
		moveStalledJobsToWait: bullmq.ScriptMoveStalledJobsToWait,
	}, nil
}
