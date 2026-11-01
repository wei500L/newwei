package economicqueue

// QueueName is the single BullMQ queue this package owns. NestJS spells it
// "akshare-data"; the Redis keys are therefore "bull:akshare-data:*".
const QueueName = "akshare-data"

// Prefix is BullMQ's default key prefix (the NestJS Queue is created without an
// explicit prefix). Both the producer and the worker must keep this value.
const Prefix = "bull"

// keySpace builds the BullMQ key names for one queue. A test can bind it to a
// scratch queue name so an integration run never touches the production
// "akshare-data" key space.
type keySpace struct {
	// base is the queue key prefix including the trailing colon, e.g.
	// "bull:akshare-data:".
	base string
}

func newKeySpace(prefix, name string) keySpace {
	if prefix == "" {
		prefix = Prefix
	}
	return keySpace{base: prefix + ":" + name + ":"}
}

func (k keySpace) job(jobID string) string      { return k.base + jobID }
func (k keySpace) wait() string                 { return k.base + "wait" }
func (k keySpace) active() string               { return k.base + "active" }
func (k keySpace) prioritized() string          { return k.base + "prioritized" }
func (k keySpace) delayed() string              { return k.base + "delayed" }
func (k keySpace) paused() string               { return k.base + "paused" }
func (k keySpace) completed() string            { return k.base + "completed" }
func (k keySpace) failed() string               { return k.base + "failed" }
func (k keySpace) stalled() string              { return k.base + "stalled" }
func (k keySpace) limiter() string              { return k.base + "limiter" }
func (k keySpace) events() string               { return k.base + "events" }
func (k keySpace) meta() string                 { return k.base + "meta" }
func (k keySpace) marker() string               { return k.base + "marker" }
func (k keySpace) id() string                   { return k.base + "id" }
func (k keySpace) priorityCounter() string      { return k.base + "pc" }
func (k keySpace) stalledCheck() string         { return k.base + "stalled-check" }
func (k keySpace) repeat() string               { return k.base + "repeat" }
func (k keySpace) repeatHash(key string) string { return k.base + "repeat:" + key }
func (k keySpace) lock(jobID string) string     { return k.job(jobID) + ":lock" }
