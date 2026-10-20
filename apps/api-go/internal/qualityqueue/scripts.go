package qualityqueue

import (
	"embed"
	"fmt"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// scriptFiles holds the expanded BullMQ 5.63.2 scripts. See NOTICE for the
// provenance and licence of every file.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// mustScript loads one embedded script. A missing file is a programming error,
// so it panics at init rather than failing a job at runtime.
func mustScript(name string) *redis.Script {
	raw, err := scriptFiles.ReadFile("scripts/" + name + ".lua")
	if err != nil {
		panic(fmt.Sprintf("qualityqueue: embedded script %s is missing: %v", name, err))
	}
	return redis.NewScript(string(raw))
}

var (
	// scriptAddStandardJob creates the job hash and pushes it to the wait list.
	scriptAddStandardJob = mustScript("addStandardJob")
	// scriptMoveToActive atomically moves one job from wait to active and
	// takes its lock.
	scriptMoveToActive = mustScript("moveToActive")
	// scriptMoveToFinished finalizes a job into completed or failed, releases
	// the lock and applies the keepJobs retention policy.
	scriptMoveToFinished = mustScript("moveToFinished")
	// scriptMoveToDelayed parks a retry in the delayed sorted set.
	scriptMoveToDelayed = mustScript("moveToDelayed")
	// scriptExtendLock renews a job lock and clears the stalled marker.
	scriptExtendLock = mustScript("extendLock")
	// scriptMoveStalledJobsToWait recovers jobs whose lock expired.
	scriptMoveStalledJobsToWait = mustScript("moveStalledJobsToWait")
)

// pack encodes the argument tuples the scripts unpack with cmsgpack.
func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("qualityqueue: encode script arguments: %w", err)
	}
	return encoded, nil
}
