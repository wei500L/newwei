package crawlworker

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueScripts is the BullMQ command set of one queue worker. The scripts are
// the shared copies in internal/bullmq; this package no longer vendors its own.
type queueScripts struct {
	moveToActive            *redis.Script
	moveToFinished          *redis.Script
	moveJobFromActiveToWait *redis.Script
	retryJob                *redis.Script
	moveToDelayed           *redis.Script
	moveStalledJobsToWait   *redis.Script
	extendLock              *redis.Script
	updateData              *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		moveToActive:            bullmq.ScriptMoveToActive,
		moveToFinished:          bullmq.ScriptMoveToFinished,
		moveJobFromActiveToWait: bullmq.ScriptMoveJobFromActiveToWait,
		retryJob:                bullmq.ScriptRetryJob,
		moveToDelayed:           bullmq.ScriptMoveToDelayed,
		moveStalledJobsToWait:   bullmq.ScriptMoveStalledJobsToWait,
		extendLock:              bullmq.ScriptExtendLock,
		updateData:              bullmq.ScriptUpdateData,
	}, nil
}
