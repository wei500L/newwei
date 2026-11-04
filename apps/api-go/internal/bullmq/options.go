package bullmq

// Backoff is BullMQ's retry backoff option (opts.backoff).
type Backoff struct {
	Type  string `msgpack:"type" json:"type"`
	Delay int64  `msgpack:"delay" json:"delay"`
}

// KeepJobs is BullMQ's removeOnComplete / removeOnFail object form. A nil field
// is omitted, so the encoded map only carries the retention keys the caller
// actually set (matching the boolean/number/object union BullMQ accepts).
type KeepJobs struct {
	Age   *int64 `msgpack:"age,omitempty" json:"age,omitempty"`
	Count *int64 `msgpack:"count,omitempty" json:"count,omitempty"`
}

// Deduplication is BullMQ's simple-mode deduplication option (opts.de). The
// deduplication key stored in Redis is <queue base>de:<id>.
type Deduplication struct {
	ID string `msgpack:"id" json:"id"`
}

// JobOptions is the MessagePack options document the add scripts store in the
// job hash. Every field is optional: a caller sets only the keys its NestJS
// Queue.add call sets, and pointer presence distinguishes a zero value from an
// unset field exactly like the JavaScript object literal.
//
// RemoveOnComplete, RemoveOnFail and Repeat are union-typed wire values:
// RemoveOnComplete and RemoveOnFail are a bool, a number or a KeepJobs object,
// and Repeat is the nested repeat-iteration template. They stay `any` because
// they are a protocol leaf, never business data.
type JobOptions struct {
	// JobID is the custom job id. An empty value asks the add script to allocate
	// one from the queue counter (BullMQ's Job.create default).
	JobID    string `msgpack:"jobId,omitempty"`
	Attempts *int64 `msgpack:"attempts,omitempty"`
	// Backoff is the retry strategy. It is a *Backoff with a delay, or, for a
	// custom strategy that stores only a type, a map with just the type key.
	Backoff any `msgpack:"backoff,omitempty"`

	RemoveOnComplete any `msgpack:"removeOnComplete,omitempty"`
	RemoveOnFail     any `msgpack:"removeOnFail,omitempty"`

	// Priority selects the prioritized add command when non-nil and non-zero.
	Priority *int64 `msgpack:"priority,omitempty"`

	// Delay selects the delayed add command when positive.
	Delay *int64 `msgpack:"delay,omitempty"`
	// Timestamp and PrevMillis are the repeat-iteration bookkeeping BullMQ stores
	// alongside a delayed repeat job.
	Timestamp  *int64 `msgpack:"timestamp,omitempty"`
	PrevMillis *int64 `msgpack:"prevMillis,omitempty"`

	Lifo          *bool          `msgpack:"lifo,omitempty"`
	Deduplication *Deduplication `msgpack:"de,omitempty"`
	Repeat        any            `msgpack:"repeat,omitempty"`
	RepeatJobKey  string         `msgpack:"repeatJobKey,omitempty"`
}
