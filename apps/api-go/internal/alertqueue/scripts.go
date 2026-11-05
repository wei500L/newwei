package alertqueue

import (
	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// The alerts queue runs the shared BullMQ 5.63.2 commands embedded in
// internal/bullmq. This package no longer vendors its own copies.
var (
	addStandardJobScript   = bullmq.ScriptAddStandardJob
	addDelayedJobScript    = bullmq.ScriptAddDelayedJob
	addRepeatableJobScript = bullmq.ScriptAddRepeatableJob
	removeRepeatableScript = bullmq.ScriptRemoveRepeatable
	removeJobScript        = bullmq.ScriptRemoveJob
)
