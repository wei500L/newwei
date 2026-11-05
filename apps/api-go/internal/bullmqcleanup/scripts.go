package bullmqcleanup

import (
	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

var (
	// scriptCleanJobsInSet is BullMQ's clean command: it deletes jobs from one
	// state set by age (and removes their hashes) and emits a cleaned event.
	scriptCleanJobsInSet = bullmq.ScriptCleanJobsInSet
	// scriptGetRanges is BullMQ's getJobs range reader. The waiting list is read
	// from the oldest end and the deprecated wait marker is popped here.
	scriptGetRanges = bullmq.ScriptGetRanges
	// scriptGetCounts reads one state count; for the waiting list it ignores the
	// deprecated marker entry.
	scriptGetCounts = bullmq.ScriptGetCounts
	// scriptRemoveJob removes one job from any state and all of its data. It
	// refuses to remove a locked job and reports a job-scheduler job as -8.
	scriptRemoveJob = bullmq.ScriptRemoveJob
)
