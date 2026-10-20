package situationsignalsworker

import "strings"

// BullMQ queue identity shared with the legacy NestJS producer and with
// internal/situationsettings/telegramsched.
const (
	// QueueName is SITUATION_MONITOR_SIGNALS_QUEUE_NAME.
	QueueName = "situationMonitorSignals"
	// QueuePrefix is BullMQ's default key prefix. The NestJS Queue is created
	// without a `prefix` option, so all keys start with "bull:".
	QueuePrefix = "bull"
	// TelegramPollJobName is TELEGRAM_POLL_JOB_NAME.
	TelegramPollJobName = "telegram-poll"
	// OrefPollJobName is OREF_POLL_JOB_NAME.
	OrefPollJobName = "oref-poll"
)

// PollSource discriminates the two pollers one queue job can trigger.
type PollSource string

const (
	// SourceTelegram is the Telegram channel poll.
	SourceTelegram PollSource = "telegram"
	// SourceOref is the Oref alert poll.
	SourceOref PollSource = "oref"
)

// Job is the queue-layer view of one claimed situationMonitorSignals job. The
// BullMQ protocol details (lock token, options, repeat key) stay private to the
// worker so the domain layer only sees what it has to act on.
type Job struct {
	// ID is the BullMQ job id.
	ID string
	// Name is the BullMQ job name, for example "telegram-poll:bootstrap".
	Name string
	// Source is the poll source resolved from the payload or the job name.
	Source PollSource
}

// ResolveSource mirrors SituationMonitorSignalsProcessor.processJob: the
// payload `data.source` wins, then the job name prefix, and anything else is
// not a poll job. The name fallback keeps jobs whose payload lost its source
// (or jobs produced by older releases) processable.
func ResolveSource(dataSource, jobName string) (PollSource, bool) {
	switch PollSource(dataSource) {
	case SourceTelegram:
		return SourceTelegram, true
	case SourceOref:
		return SourceOref, true
	}
	if strings.HasPrefix(jobName, TelegramPollJobName) {
		return SourceTelegram, true
	}
	if strings.HasPrefix(jobName, OrefPollJobName) {
		return SourceOref, true
	}
	return "", false
}

// jobTypePoll is the only data.type the queue carries.
const jobTypePoll = "poll"

// pollJobData is the typed `data` payload written by the NestJS processor and
// by EnsureRepeatables: {"type":"poll","source":"telegram"|"oref"}.
type pollJobData struct {
	Type   string     `json:"type"`
	Source PollSource `json:"source"`
}
