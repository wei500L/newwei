package queue

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueScripts is the BullMQ command set of one queue worker. The scripts are
// the shared copies in internal/bullmq; this package no longer vendors its own.
type queueScripts struct {
	addStandardJob        *redis.Script
	addDelayedJob         *redis.Script
	addRepeatableJob      *redis.Script
	removeRepeatable      *redis.Script
	removeJob             *redis.Script
	moveToActive          *redis.Script
	moveToFinished        *redis.Script
	moveToDelayed         *redis.Script
	extendLock            *redis.Script
	moveStalledJobsToWait *redis.Script
	retryJob              *redis.Script
	updateData            *redis.Script
	updateJobScheduler    *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		addStandardJob:        bullmq.ScriptAddStandardJob,
		addDelayedJob:         bullmq.ScriptAddDelayedJob,
		addRepeatableJob:      bullmq.ScriptAddRepeatableJob,
		removeRepeatable:      bullmq.ScriptRemoveRepeatable,
		removeJob:             bullmq.ScriptRemoveJob,
		moveToActive:          bullmq.ScriptMoveToActive,
		moveToFinished:        bullmq.ScriptMoveToFinished,
		moveToDelayed:         bullmq.ScriptMoveToDelayed,
		extendLock:            bullmq.ScriptExtendLock,
		moveStalledJobsToWait: bullmq.ScriptMoveStalledJobsToWait,
		retryJob:              bullmq.ScriptRetryJob,
		updateData:            bullmq.ScriptUpdateData,
		updateJobScheduler:    bullmq.ScriptUpdateJobScheduler,
	}, nil
}
