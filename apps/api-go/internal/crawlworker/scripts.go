package crawlworker

import (
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueScripts is the BullMQ command set the crawl attempt drives itself. The
// fetch loop, lock renewal and stalled checker now live in internal/bullmq, so
// only the transitions remain here; the scripts are the shared copies in
// internal/bullmq and this package no longer vendors its own.
type queueScripts struct {
	moveToFinished          *redis.Script
	moveJobFromActiveToWait *redis.Script
	retryJob                *redis.Script
	moveToDelayed           *redis.Script
	updateData              *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		moveToFinished:          bullmq.ScriptMoveToFinished,
		moveJobFromActiveToWait: bullmq.ScriptMoveJobFromActiveToWait,
		retryJob:                bullmq.ScriptRetryJob,
		moveToDelayed:           bullmq.ScriptMoveToDelayed,
		updateData:              bullmq.ScriptUpdateData,
	}, nil
}
