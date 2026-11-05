package qualityqueue

import (
	"fmt"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// The queue scripts are the shared BullMQ 5.63.2 commands embedded in
// internal/bullmq. This package no longer vendors its own copies.
var (
	// scriptAddStandardJob creates the job hash and pushes it to the wait list.
	scriptAddStandardJob = bullmq.ScriptAddStandardJob
	// scriptMoveToActive atomically moves one job from wait to active and
	// takes its lock.
	scriptMoveToActive = bullmq.ScriptMoveToActive
	// scriptMoveToFinished finalizes a job into completed or failed, releases
	// the lock and applies the keepJobs retention policy.
	scriptMoveToFinished = bullmq.ScriptMoveToFinished
	// scriptMoveToDelayed parks a retry in the delayed sorted set.
	scriptMoveToDelayed = bullmq.ScriptMoveToDelayed
	// scriptExtendLock renews a job lock and clears the stalled marker.
	scriptExtendLock = bullmq.ScriptExtendLock
	// scriptMoveStalledJobsToWait recovers jobs whose lock expired.
	scriptMoveStalledJobsToWait = bullmq.ScriptMoveStalledJobsToWait
)

// pack encodes the worker option tuples the scripts unpack with cmsgpack.
func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("qualityqueue: encode script arguments: %w", err)
	}
	return encoded, nil
}
