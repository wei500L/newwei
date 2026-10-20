package qualityqueue

// QueueName is the BullMQ queue name shared with NestJS
// (CLASSIFICATION_QUALITY_QUEUE_NAME in classification-quality.constants.ts).
// NestJS spells it with an underscore; the Redis keys are therefore
// "bull:classification_quality:*".
const QueueName = "classification_quality"

// defaultPrefix is the BullMQ default key prefix. The NestJS Queue is created
// without an explicit prefix, so both sides must keep this value.
const defaultPrefix = "bull"

// keySpace builds the BullMQ key names for one queue.
type keySpace struct {
	// base is the queue key prefix including the trailing colon, e.g.
	// "bull:classification_quality:".
	base string
}

func newKeySpace(prefix, name string) keySpace {
	if prefix == "" {
		prefix = defaultPrefix
	}
	return keySpace{base: prefix + ":" + name + ":"}
}

// job is the hash key of one job.
func (k keySpace) job(jobID string) string { return k.base + jobID }

func (k keySpace) wait() string             { return k.base + "wait" }
func (k keySpace) active() string           { return k.base + "active" }
func (k keySpace) prioritized() string      { return k.base + "prioritized" }
func (k keySpace) delayed() string          { return k.base + "delayed" }
func (k keySpace) paused() string           { return k.base + "paused" }
func (k keySpace) completed() string        { return k.base + "completed" }
func (k keySpace) failed() string           { return k.base + "failed" }
func (k keySpace) stalled() string          { return k.base + "stalled" }
func (k keySpace) limiter() string          { return k.base + "limiter" }
func (k keySpace) events() string           { return k.base + "events" }
func (k keySpace) meta() string             { return k.base + "meta" }
func (k keySpace) marker() string           { return k.base + "marker" }
func (k keySpace) id() string               { return k.base + "id" }
func (k keySpace) priorityCounter() string  { return k.base + "pc" }
func (k keySpace) stalledCheck() string     { return k.base + "stalled-check" }
func (k keySpace) lock(jobID string) string { return k.job(jobID) + ":lock" }
func (k keySpace) metrics(target string) string {
	return k.base + "metrics:" + target
}
