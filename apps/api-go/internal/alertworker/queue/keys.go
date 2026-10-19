package queue

// BullMQ's key layout for the alerts queue.
const (
	// Prefix is BullMQ's default key prefix. The NestJS Queue is constructed
	// without a `prefix` option, so it uses the same default.
	Prefix = "bull"
	// QueueName is ALERTS_QUEUE_NAME in apps/api: the shared queue.
	QueueName = "alerts"

	// FailedRetentionAgeSeconds / FailedRetentionCount mirror
	// BULLMQ_FAILED_JOB_RETENTION ({age: 7 days, count: 10_000}), which is both
	// the Queue's defaultJobOptions.removeOnFail and the explicit option on
	// every evaluate job.
	FailedRetentionAgeSeconds = 7 * 24 * 60 * 60
	FailedRetentionCount      = 10_000
)

// Job types are the `data.type` discriminators the NestJS worker branches on.
const (
	JobTypeScan     = "scan"
	JobTypeEvaluate = "evaluate"
	JobTypeDeliver  = "deliver"
)

// Job names. The NestJS worker matches by prefix, so every rule job name must
// keep the `evaluate-rule:` prefix and every delivery job name the
// `deliver-notification:` prefix.
const (
	JobNameScan          = "scan-active-rules"
	JobNameRulePrefix    = "evaluate-rule:"
	JobNameDeliverPrefix = "deliver-notification:"
)

// Keys is the BullMQ queue key set: `<prefix>:<queue>:<suffix>`.
type Keys struct {
	Prefix      string
	Base        string
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
	Stalled     string
	Limiter     string
	PC          string
	Prioritized string
	Repeat      string
}

// NewKeys builds the key set for one queue name and prefix.
func NewKeys(prefix, queueName string) Keys {
	if prefix == "" {
		prefix = Prefix
	}
	base := prefix + ":" + queueName + ":"
	key := func(suffix string) string { return base + suffix }
	return Keys{
		Prefix:      prefix,
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
		Stalled:     key("stalled"),
		Limiter:     key("limiter"),
		PC:          key("pc"),
		Prioritized: key("prioritized"),
		Repeat:      key("repeat"),
	}
}

// Job returns the job hash key for one job id.
func (k Keys) Job(id string) string { return k.Base + id }

// RuleJobName is the BullMQ job name of one rule's evaluation jobs.
func RuleJobName(ruleID string) string { return JobNameRulePrefix + ruleID }

// DeliveryJobName is the BullMQ job name of one delivery job.
func DeliveryJobName(deliveryID string) string { return JobNameDeliverPrefix + deliveryID }
