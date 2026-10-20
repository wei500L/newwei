// Package archivepreparation is the Go producer for the NestJS archive
// preparation queue.
//
// It owns only the compatible BullMQ wire for this one chain: getState, the
// locked remove and the standard add used by ArchivePreparationQueueService,
// plus the derived status record the migrated status HTTP already reads. The
// worker, classification generation, display-signal backfill and SQL writes
// remain owned by the NestJS ArchivePreparationProcessor.
package archivepreparation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

const (
	// QueueName is the exact BullMQ queue name shared with NestJS.
	QueueName = "archivePreparation"
	// DefaultPrefix is BullMQ's default key prefix.
	DefaultPrefix = "bull"
	// StatusTTLSeconds is the derived status TTL.
	StatusTTLSeconds = 3600
	// StatusIndexKey is the global recency index.
	StatusIndexKey = "archive:preparation:status:index"
	// StatusIndexMaxEntries is the global index cap.
	StatusIndexMaxEntries = 200
)

// Scope is the closed archive preparation scope.
type Scope string

const (
	// ScopeDigest prepares a digest anchor day.
	ScopeDigest Scope = "digest"
	// ScopeCalendar prepares a calendar month.
	ScopeCalendar Scope = "calendar"
)

// Payload is the named job data written into the BullMQ job hash. Field order
// and JSON names match ArchivePreparationJobPayload.
type Payload struct {
	Scope      Scope  `json:"scope"`
	OrgID      string `json:"orgId"`
	AnchorDate string `json:"anchorDate,omitempty"`
	Month      string `json:"month,omitempty"`
	TraceID    string `json:"traceId,omitempty"`
}

// ScopeValue is the date for digest jobs and the month for calendar jobs.
func (p Payload) ScopeValue() string {
	if p.Scope == ScopeDigest {
		if p.AnchorDate != "" {
			return p.AnchorDate
		}
		return "unknown"
	}
	if p.Month != "" {
		return p.Month
	}
	return "unknown"
}

// JobID is the exact three-segment custom id allowed by BullMQ 5.63.2.
func (p Payload) JobID() string {
	return string(p.Scope) + ":" + p.OrgID + ":" + p.ScopeValue()
}

// JobOptions is the MessagePack options object added to the job hash. Its JSON
// form (inside Redis) is what the NestJS worker reads back.
type JobOptions struct {
	Attempts         int                  `msgpack:"attempts"`
	Backoff          JobBackoff           `msgpack:"backoff"`
	RemoveOnComplete RemoveOnCompleteOpts `msgpack:"removeOnComplete"`
	RemoveOnFail     RemoveOnFailOpts     `msgpack:"removeOnFail"`
	JobID            string               `msgpack:"jobId"`
}

// JobBackoff is exponential retry with the fixed 15s base.
type JobBackoff struct {
	Type  string `msgpack:"type"`
	Delay int64  `msgpack:"delay"`
}

// RemoveOnCompleteOpts keeps at most 1000 completed jobs for one hour.
type RemoveOnCompleteOpts struct {
	Age   int64 `msgpack:"age"`
	Count int64 `msgpack:"count"`
}

// RemoveOnFailOpts keeps at most 10000 failed jobs for seven days.
type RemoveOnFailOpts struct {
	Age   int64 `msgpack:"age"`
	Count int64 `msgpack:"count"`
}

// StatusRecord is the derived preparation status record. ErrorMessage is
// omitted when empty, exactly like the Nest writer.
type StatusRecord struct {
	OrgID        string  `json:"orgId"`
	Scope        Scope   `json:"scope"`
	ScopeValue   string  `json:"scopeValue"`
	State        string  `json:"state"`
	UpdatedAt    string  `json:"updatedAt"`
	ErrorMessage *string `json:"errorMessage,omitempty"`
}

// Status is the GraphQL-facing digest status projection.
type Status struct {
	State        string
	UpdatedAt    time.Time
	ErrorMessage *string
}

// Producer talks to the shared Redis instance with the fixed BullMQ scripts.
type Producer struct {
	redis  *redis.Client
	prefix string
	now    func() time.Time
}

// NewProducer builds the producer on the shared Redis client.
func NewProducer(client *redis.Client) *Producer {
	return &Producer{redis: client, prefix: DefaultPrefix, now: time.Now}
}

// WithPrefix overrides the BullMQ key prefix (used by the Redis integration
// test to isolate its keys). Production keeps the NestJS default.
func (p *Producer) WithPrefix(prefix string) *Producer {
	if trimmed := strings.TrimSpace(prefix); trimmed != "" {
		p.prefix = trimmed
	}
	return p
}

var (
	addJobScript = redis.NewScript(addStandardJobLua)
	stateScript  = redis.NewScript(getStateV2Lua)
	removeScript = redis.NewScript(removeJobLua)
)

// EnsureDigestCoverage queues one digest prep job, deduping waiting/active/
// delayed jobs and replacing any other state through the official locked
// remove.
func (p *Producer) EnsureDigestCoverage(ctx context.Context, orgID, anchorDate string) error {
	return p.ensureQueued(ctx, Payload{Scope: ScopeDigest, OrgID: orgID, AnchorDate: anchorDate})
}

// EnsureCalendarCoverage queues one calendar prep job.
func (p *Producer) EnsureCalendarCoverage(ctx context.Context, orgID, month string) error {
	return p.ensureQueued(ctx, Payload{Scope: ScopeCalendar, OrgID: orgID, Month: month})
}

func (p *Producer) ensureQueued(ctx context.Context, payload Payload) error {
	if p == nil || p.redis == nil {
		return errors.New("archive preparation producer requires redis")
	}
	payload.TraceID = httpx.EnsureTraceID(httpx.TraceIDFromContext(ctx))
	jobID := payload.JobID()
	state, err := p.jobState(ctx, jobID)
	if err != nil {
		return err
	}
	switch state {
	case "waiting", "active", "delayed":
		return nil
	}
	if state != "unknown" {
		if err := p.removeJob(ctx, jobID); err != nil {
			return err
		}
	}
	if err := p.addJob(ctx, payload); err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return nil
		}
		return err
	}
	// The status write is best effort: a queued job must not be reported as a
	// failed enqueue only because Redis refused the diagnostic record.
	if err := p.writeStatus(ctx, payload, "QUEUED", ""); err != nil {
		return nil
	}
	return nil
}

// jobState mirrors Scripts.getState for Redis >= 6.0.6. The paused list also
// answers "waiting", exactly like the official getStateV2 script.
func (p *Producer) jobState(ctx context.Context, jobID string) (string, error) {
	keys := []string{
		p.key("completed"), p.key("failed"), p.key("delayed"), p.key("active"),
		p.key("wait"), p.key("paused"), p.key("waiting-children"), p.key("prioritized"),
	}
	value, err := stateScript.Run(ctx, p.redis, keys, jobID).Result()
	if err != nil {
		return "", err
	}
	state, _ := value.(string)
	if state == "" {
		return "unknown", nil
	}
	return state, nil
}

func (p *Producer) removeJob(ctx context.Context, jobID string) error {
	keys := []string{p.key(jobID), p.key("repeat")}
	_, err := removeScript.Run(ctx, p.redis, keys, jobID, "0", p.basePrefix()).Result()
	return err
}

func (p *Producer) addJob(ctx context.Context, payload Payload) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	args := []any{
		p.basePrefix(), payload.JobID(), QueueName, p.now().UnixMilli(),
		nil, nil, nil, nil, nil,
	}
	packedArgs, err := msgpack.Marshal(args)
	if err != nil {
		return err
	}
	packedOpts, err := msgpack.Marshal(JobOptions{
		Attempts:         5,
		Backoff:          JobBackoff{Type: "exponential", Delay: 15000},
		RemoveOnComplete: RemoveOnCompleteOpts{Age: StatusTTLSeconds, Count: 1000},
		RemoveOnFail:     RemoveOnFailOpts{Age: 604800, Count: 10000},
		JobID:            payload.JobID(),
	})
	if err != nil {
		return err
	}
	keys := []string{
		p.key("wait"), p.key("paused"), p.key("meta"), p.key("id"), p.key("completed"),
		p.key("delayed"), p.key("active"), p.key("events"), p.key("marker"),
	}
	result, err := addJobScript.Run(ctx, p.redis, keys, packedArgs, string(data), packedOpts).Result()
	if err != nil {
		return err
	}
	switch value := result.(type) {
	case int64:
		if value < 0 {
			return fmt.Errorf("archive preparation addJob rejected with code %d", value)
		}
	case string:
		if value == "" {
			return errors.New("archive preparation addJob returned an empty id")
		}
	case []byte:
		if len(value) == 0 {
			return errors.New("archive preparation addJob returned an empty id")
		}
	default:
		return errors.New("archive preparation addJob returned an unexpected result")
	}
	return nil
}

// writeStatus stores the QUEUED record and trims the global index to 200.
func (p *Producer) writeStatus(ctx context.Context, payload Payload, state, errorMessage string) error {
	record := StatusRecord{
		OrgID:      payload.OrgID,
		Scope:      payload.Scope,
		ScopeValue: payload.ScopeValue(),
		State:      state,
		UpdatedAt:  p.now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if errorMessage != "" {
		record.ErrorMessage = &errorMessage
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	key := p.statusKey(payload.Scope, payload.OrgID, payload.ScopeValue())
	pipe := p.redis.TxPipeline()
	pipe.Set(ctx, key, encoded, StatusTTLSeconds*time.Second)
	pipe.ZAdd(ctx, StatusIndexKey, redis.Z{Score: float64(p.now().UnixMilli()), Member: key})
	if _, err := pipe.Exec(ctx); err != nil {
		return err
	}
	return p.trimStatusIndex(ctx)
}

func (p *Producer) trimStatusIndex(ctx context.Context) error {
	total, err := p.redis.ZCard(ctx, StatusIndexKey).Result()
	if err != nil || total <= StatusIndexMaxEntries {
		return err
	}
	overflow := total - StatusIndexMaxEntries
	keys, err := p.redis.ZRange(ctx, StatusIndexKey, 0, overflow-1).Result()
	if err != nil || len(keys) == 0 {
		return err
	}
	pipe := p.redis.TxPipeline()
	pipe.ZRem(ctx, StatusIndexKey, stringSliceToAny(keys)...)
	pipe.Del(ctx, keys...)
	_, err = pipe.Exec(ctx)
	return err
}

// ReadDigestStatus reads the derived record for one digest anchor. A missing
// record is (nil, nil); the error text is redacted before it leaves the process.
func (p *Producer) ReadDigestStatus(ctx context.Context, orgID, anchorDate string) (*Status, error) {
	return p.readStatus(ctx, ScopeDigest, orgID, anchorDate)
}

// ReadStatus reads one derived status record by scope. It is the narrow port
// the archive reading service consumes.
func (p *Producer) ReadStatus(ctx context.Context, scope, orgID, scopeValue string) (*Status, error) {
	return p.readStatus(ctx, Scope(scope), orgID, scopeValue)
}

func (p *Producer) readStatus(ctx context.Context, scope Scope, orgID, scopeValue string) (*Status, error) {
	if p == nil || p.redis == nil {
		return nil, errors.New("archive preparation producer requires redis")
	}
	raw, err := p.redis.Get(ctx, p.statusKey(scope, orgID, scopeValue)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record StatusRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, nil
	}
	updatedAt, parseErr := time.Parse(time.RFC3339Nano, record.UpdatedAt)
	if parseErr != nil {
		updatedAt = p.now().UTC()
	}
	status := &Status{State: record.State, UpdatedAt: updatedAt}
	if record.ErrorMessage != nil {
		redacted := adminlogs.RedactSensitiveFields(*record.ErrorMessage)
		status.ErrorMessage = &redacted
	}
	return status, nil
}

func (p *Producer) statusKey(scope Scope, orgID, scopeValue string) string {
	return "archive:preparation:status:" + string(scope) + ":" + orgID + ":" + scopeValue
}

func (p *Producer) basePrefix() string { return p.prefix + ":" + QueueName + ":" }

func (p *Producer) key(suffix string) string { return p.basePrefix() + suffix }

// stringSliceToAny adapts ZRem's variadic member list at the Redis protocol
// boundary.
func stringSliceToAny(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

// ParseState maps a stored state onto the shared archive preparation enum.
func ParseState(value string) dataruntimesettings.ArchivePreparationState {
	switch dataruntimesettings.ArchivePreparationState(strings.TrimSpace(value)) {
	case dataruntimesettings.ArchiveStateIdle:
		return dataruntimesettings.ArchiveStateIdle
	case dataruntimesettings.ArchiveStateQueued:
		return dataruntimesettings.ArchiveStateQueued
	case dataruntimesettings.ArchiveStateProcessing:
		return dataruntimesettings.ArchiveStateProcessing
	case dataruntimesettings.ArchiveStatePartial:
		return dataruntimesettings.ArchiveStatePartial
	case dataruntimesettings.ArchiveStateReady:
		return dataruntimesettings.ArchiveStateReady
	case dataruntimesettings.ArchiveStateFailed:
		return dataruntimesettings.ArchiveStateFailed
	default:
		return ""
	}
}
