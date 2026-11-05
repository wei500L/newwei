package economicqueue

import (
	"fmt"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// queueScripts is the BullMQ command set of one queue worker. The scripts are
// the shared copies in internal/bullmq; this package no longer vendors its own.
type queueScripts struct {
	addStandardJob        *redis.Script
	moveToActive          *redis.Script
	extendLock            *redis.Script
	moveToFinished        *redis.Script
	moveStalledJobsToWait *redis.Script
	updateRepeat          *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		addStandardJob:        bullmq.ScriptAddStandardJob,
		moveToActive:          bullmq.ScriptMoveToActive,
		extendLock:            bullmq.ScriptExtendLock,
		moveToFinished:        bullmq.ScriptMoveToFinished,
		moveStalledJobsToWait: bullmq.ScriptMoveStalledJobsToWait,
		updateRepeat:          bullmq.ScriptUpdateRepeat,
	}, nil
}

// defaultQueueScripts is loaded once for the package-level producers.
var defaultQueueScripts = mustLoadScripts()

func mustLoadScripts() queueScripts {
	scripts, err := loadQueueScripts()
	if err != nil {
		panic(err)
	}
	return scripts
}

// pack encodes the argument tuples the scripts unpack with cmsgpack.
func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("economicqueue: pack msgpack: %w", err)
	}
	return encoded, nil
}
