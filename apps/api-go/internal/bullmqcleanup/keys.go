package bullmqcleanup

// defaultPrefix is the BullMQ default key prefix. Every NestJS Queue in this
// repository is constructed without an explicit prefix, so both sides use
// "bull". BULLMQ_NAMESPACE is the cache namespace, not the queue prefix.
const defaultPrefix = "bull"

// queueKeys returns the key prefix of one queue, including the trailing colon
// (BullMQ's Queue.toKey("")).
func queueKeys(name string) string {
	return defaultPrefix + ":" + name + ":"
}
