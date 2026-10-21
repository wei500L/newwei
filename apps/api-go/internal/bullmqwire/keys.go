package bullmqwire

// Prefix is BullMQ's default key prefix. Every Queue in apps/api is constructed
// without an explicit `prefix` option, so NestJS and api-go share this value.
const Prefix = "bull"

// Keys is the BullMQ Redis key set of one queue: `<prefix>:<queue>:<suffix>`.
//
// The suffixes are the ones BullMQ 5.63.2 builds in dist/cjs/classes/queue.js
// (QueueKeys): the job key is the bare prefix plus the job id, and the remaining
// keys are prefix plus a fixed suffix.
type Keys struct {
	// Prefix is the BullMQ key prefix ("bull" unless a queue overrides it).
	Prefix string
	// Name is the BullMQ queue name.
	Name string
	// Base is `<prefix>:<queue>:`, the prefix of every derived key.
	Base string

	Wait        string
	Paused      string
	Meta        string
	ID          string
	Completed   string
	Failed      string
	Delayed     string
	Active      string
	Events      string
	Marker      string
	Prioritized string
	PC          string
	Repeat      string
	Stalled     string
	Limiter     string
}

// NewKeys builds the key set for one queue. An empty prefix falls back to
// Prefix, mirroring BullMQ's default.
func NewKeys(prefix, queueName string) Keys {
	if prefix == "" {
		prefix = Prefix
	}
	base := prefix + ":" + queueName + ":"
	key := func(suffix string) string { return base + suffix }
	return Keys{
		Prefix:      prefix,
		Name:        queueName,
		Base:        base,
		Wait:        key("wait"),
		Paused:      key("paused"),
		Meta:        key("meta"),
		ID:          key("id"),
		Completed:   key("completed"),
		Failed:      key("failed"),
		Delayed:     key("delayed"),
		Active:      key("active"),
		Events:      key("events"),
		Marker:      key("marker"),
		Prioritized: key("prioritized"),
		PC:          key("pc"),
		Repeat:      key("repeat"),
		Stalled:     key("stalled"),
		Limiter:     key("limiter"),
	}
}

// Job returns the hash key of one job (`<prefix>:<queue>:<id>`).
func (k Keys) Job(jobID string) string { return k.Base + jobID }

// Logs returns the list key holding one job's log rows. BullMQ appends through
// addLog-2.lua to `toKey(jobId) + ':logs'` and trims it with keepLogs.
func (k Keys) Logs(jobID string) string { return k.Job(jobID) + ":logs" }
