package bullmq

import (
	"embed"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// scriptFiles embeds the single copy of every BullMQ 5.63.2 Lua command this
// module uses. See NOTICE for the provenance and licence.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// mustScript loads one embedded script. A missing or empty file is a
// programming error, so it panics at init instead of failing a job at runtime.
func mustScript(file string) *redis.Script {
	content, err := scriptFiles.ReadFile("scripts/" + file)
	if err != nil {
		panic(fmt.Sprintf("bullmq: embedded script %s is missing: %v", file, err))
	}
	if len(content) == 0 {
		panic(fmt.Sprintf("bullmq: embedded script %s is empty", file))
	}
	return redis.NewScript(string(content))
}

// The exported scripts are the only copies of the BullMQ commands in the
// repository. Producers and workers reference these values instead of embedding
// their own scripts/ directory.
var (
	ScriptAddDelayedJob           = mustScript("addDelayedJob-6.lua")
	ScriptAddJobScheduler         = mustScript("addJobScheduler-11.lua")
	ScriptAddPrioritizedJob       = mustScript("addPrioritizedJob-9.lua")
	ScriptAddRepeatableJob        = mustScript("addRepeatableJob-2.lua")
	ScriptAddStandardJob          = mustScript("addStandardJob-9.lua")
	ScriptCleanJobsInSet          = mustScript("cleanJobsInSet-3.lua")
	ScriptExtendLock              = mustScript("extendLock-2.lua")
	ScriptGetCounts               = mustScript("getCounts-1.lua")
	ScriptGetRanges               = mustScript("getRanges-1.lua")
	ScriptGetStateV2              = mustScript("getStateV2-8.lua")
	ScriptMoveJobFromActiveToWait = mustScript("moveJobFromActiveToWait-9.lua")
	ScriptMoveStalledJobsToWait   = mustScript("moveStalledJobsToWait-8.lua")
	ScriptMoveToActive            = mustScript("moveToActive-11.lua")
	ScriptMoveToDelayed           = mustScript("moveToDelayed-8.lua")
	ScriptMoveToFinished          = mustScript("moveToFinished-14.lua")
	ScriptPause                   = mustScript("pause-7.lua")
	ScriptPromote                 = mustScript("promote-9.lua")
	ScriptRemoveJob               = mustScript("removeJob-2.lua")
	ScriptRemoveJobScheduler      = mustScript("removeJobScheduler-3.lua")
	ScriptRemoveRepeatable        = mustScript("removeRepeatable-3.lua")
	ScriptReprocessJob            = mustScript("reprocessJob-8.lua")
	ScriptRetryJob                = mustScript("retryJob-11.lua")
	ScriptUpdateData              = mustScript("updateData-1.lua")
	ScriptUpdateJobScheduler      = mustScript("updateJobScheduler-12.lua")
	ScriptUpdateRepeat            = mustScript("updateRepeat-4.lua")
)

// ScriptEntry pairs one embedded command with the numberOfKeys encoded in its
// filename (<command>-<numberOfKeys>.lua).
type ScriptEntry struct {
	Name         string
	NumberOfKeys int
	Script       *redis.Script
}

// Scripts returns every embedded command with its parsed number of KEYS. It is
// used by tests and diagnostics to prove every script loads and its filename
// suffix matches a positive key count.
func Scripts() []ScriptEntry {
	files := []string{
		"addDelayedJob-6.lua",
		"addJobScheduler-11.lua",
		"addPrioritizedJob-9.lua",
		"addRepeatableJob-2.lua",
		"addStandardJob-9.lua",
		"cleanJobsInSet-3.lua",
		"extendLock-2.lua",
		"getCounts-1.lua",
		"getRanges-1.lua",
		"getStateV2-8.lua",
		"moveJobFromActiveToWait-9.lua",
		"moveStalledJobsToWait-8.lua",
		"moveToActive-11.lua",
		"moveToDelayed-8.lua",
		"moveToFinished-14.lua",
		"pause-7.lua",
		"promote-9.lua",
		"removeJob-2.lua",
		"removeJobScheduler-3.lua",
		"removeRepeatable-3.lua",
		"reprocessJob-8.lua",
		"retryJob-11.lua",
		"updateData-1.lua",
		"updateJobScheduler-12.lua",
		"updateRepeat-4.lua",
	}
	entries := make([]ScriptEntry, 0, len(files))
	for _, file := range files {
		name, keys := splitScriptFile(file)
		entries = append(entries, ScriptEntry{Name: name, NumberOfKeys: keys, Script: mustScript(file)})
	}
	return entries
}

// splitScriptFile splits "<command>-<numberOfKeys>.lua" into the command name and
// the key count.
func splitScriptFile(file string) (string, int) {
	trimmed := strings.TrimSuffix(file, ".lua")
	index := strings.LastIndex(trimmed, "-")
	if index <= 0 {
		panic(fmt.Sprintf("bullmq: embedded script %s has no -<numberOfKeys> suffix", file))
	}
	keys, err := strconv.Atoi(trimmed[index+1:])
	if err != nil || keys <= 0 {
		panic(fmt.Sprintf("bullmq: embedded script %s has an invalid key count", file))
	}
	return trimmed[:index], keys
}

// ReadScript returns the raw bytes of one embedded script by its canonical
// filename (for example "moveToFinished-14.lua"). It lets callers and tests
// inspect the single vendored copy instead of a package-local duplicate.
func ReadScript(file string) ([]byte, error) {
	return scriptFiles.ReadFile("scripts/" + file)
}
