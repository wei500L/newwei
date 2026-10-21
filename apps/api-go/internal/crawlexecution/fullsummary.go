package crawlexecution

// CrawlExecutionSummary (FullSummary) and its JSON projection.
//
// runTask resolves to a plain object in NestJS; BullMQ stores it as the job
// returnvalue and the NestJS QueueEvents reader (CrawlQueueEventPublisher)
// forwards it verbatim as the COMPLETED payload of the ops socket. The
// serialized form therefore has to match the NestJS object member for member,
// in the same order, with the same undefined-omission and Date rules:
//
//	inserted, skipped, reusedResultId?, itemsQueued?, itemsQueueFailed?,
//	lastFetchedAt?, runId?, memory?, failures?, retryableFailures?
//
// Members whose NestJS value is undefined are omitted (never null); Date values
// are Date.prototype.toISOString strings (millisecond precision, UTC, "Z").
// memory and failure objects keep their own member order for the same reason.

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// MemoryStats is CrawlMemoryStats. A nil member is an undefined NestJS member
// and is omitted from JSON.
type MemoryStats struct {
	ServerMemoryMB    *float64
	PeakMemoryMB      *float64
	EfficiencyPercent *float64
}

// FullSummary is CrawlExecutionSummary: the runTask resolve value on both the
// pipeline and the BullMQ worker path. Pointer members mirror the optional
// NestJS members: nil means undefined (omitted), non-nil means present even
// when the pointed-to value is zero.
type FullSummary struct {
	Inserted          int
	Skipped           int
	ReusedResultID    *string
	ItemsQueued       *int
	ItemsQueueFailed  *int
	LastFetchedAt     *time.Time
	RunID             *string
	Memory            *MemoryStats
	Failures          []Failure
	RetryableFailures *int
}

// pipelineSummaryFrom projects a FullSummary onto the Summary the pipeline
// bridge consumes. The projection is lossy on purpose: Summary has no memory
// block and uses plain values for the optional members.
func pipelineSummaryFrom(full FullSummary) Summary {
	summary := Summary{
		Inserted:      full.Inserted,
		Skipped:       full.Skipped,
		LastFetchedAt: full.LastFetchedAt,
		Failures:      full.Failures,
	}
	if full.ReusedResultID != nil {
		summary.ReusedResultID = *full.ReusedResultID
	}
	if full.ItemsQueued != nil {
		summary.ItemsQueued = *full.ItemsQueued
	}
	if full.ItemsQueueFailed != nil {
		summary.ItemsQueueFailed = *full.ItemsQueueFailed
	}
	if full.RunID != nil {
		summary.RunID = *full.RunID
	}
	if full.RetryableFailures != nil {
		summary.RetryableFailures = *full.RetryableFailures
	}
	return summary
}

// fullSummaryFromPersisted builds the runTask summary from the persistResults
// projection. memory is only attached when at least one memory stat exists,
// matching extractMemoryStats returning undefined for an all-undefined
// response; the item counters are only attached when ingestToItems was on,
// matching the `...(ingestToItems ? {...} : {})` spread.
func fullSummaryFromPersisted(summary Summary, memory memoryStats, ingestToItems bool) FullSummary {
	full := FullSummary{
		Inserted:      summary.Inserted,
		Skipped:       summary.Skipped,
		LastFetchedAt: summary.LastFetchedAt,
	}
	if summary.ReusedResultID != "" {
		reused := summary.ReusedResultID
		full.ReusedResultID = &reused
	}
	if ingestToItems {
		itemsQueued := summary.ItemsQueued
		itemsQueueFailed := summary.ItemsQueueFailed
		full.ItemsQueued = &itemsQueued
		full.ItemsQueueFailed = &itemsQueueFailed
	}
	if summary.RunID != "" {
		runID := summary.RunID
		full.RunID = &runID
	}
	if memory.ServerMemoryMB != nil || memory.PeakMemoryMB != nil || memory.EfficiencyPercent != nil {
		full.Memory = &MemoryStats{
			ServerMemoryMB:    memory.ServerMemoryMB,
			PeakMemoryMB:      memory.PeakMemoryMB,
			EfficiencyPercent: memory.EfficiencyPercent,
		}
	}
	return full
}

// isoMillisJS is Date.prototype.toISOString: UTC, millisecond precision, "Z".
func isoMillisJS(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// jsonMember is one ordered JSON object member.
type jsonMember struct {
	Key   string
	Value any
}

// marshalOrderedJSON writes the members in slice order. encoding/json cannot
// express member order for maps or structs, so the summary types assemble the
// object literal themselves.
func marshalOrderedJSON(members []jsonMember) ([]byte, error) {
	builder := bytes.NewBuffer(make([]byte, 0, 256))
	builder.WriteByte('{')
	for index, member := range members {
		if index > 0 {
			builder.WriteByte(',')
		}
		key, err := json.Marshal(member.Key)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(member.Value)
		if err != nil {
			return nil, err
		}
		builder.Write(key)
		builder.WriteByte(':')
		builder.Write(value)
	}
	builder.WriteByte('}')
	return builder.Bytes(), nil
}

// MarshalJSON emits CrawlExecutionSummary in the NestJS member order.
func (s FullSummary) MarshalJSON() ([]byte, error) {
	members := make([]jsonMember, 0, 10)
	members = append(members,
		jsonMember{Key: "inserted", Value: s.Inserted},
		jsonMember{Key: "skipped", Value: s.Skipped},
	)
	if s.ReusedResultID != nil {
		members = append(members, jsonMember{Key: "reusedResultId", Value: *s.ReusedResultID})
	}
	if s.ItemsQueued != nil {
		members = append(members, jsonMember{Key: "itemsQueued", Value: *s.ItemsQueued})
	}
	if s.ItemsQueueFailed != nil {
		members = append(members, jsonMember{Key: "itemsQueueFailed", Value: *s.ItemsQueueFailed})
	}
	if s.LastFetchedAt != nil {
		members = append(members, jsonMember{Key: "lastFetchedAt", Value: isoMillisJS(*s.LastFetchedAt)})
	}
	if s.RunID != nil {
		members = append(members, jsonMember{Key: "runId", Value: *s.RunID})
	}
	if s.Memory != nil {
		members = append(members, jsonMember{Key: "memory", Value: *s.Memory})
	}
	if s.Failures != nil {
		members = append(members, jsonMember{Key: "failures", Value: s.Failures})
	}
	if s.RetryableFailures != nil {
		members = append(members, jsonMember{Key: "retryableFailures", Value: *s.RetryableFailures})
	}
	return marshalOrderedJSON(members)
}

// MarshalJSON emits CrawlMemoryStats in the NestJS member order, omitting the
// undefined (nil) members.
func (m MemoryStats) MarshalJSON() ([]byte, error) {
	members := make([]jsonMember, 0, 3)
	if m.ServerMemoryMB != nil {
		members = append(members, jsonMember{Key: "serverMemoryMb", Value: *m.ServerMemoryMB})
	}
	if m.PeakMemoryMB != nil {
		members = append(members, jsonMember{Key: "peakMemoryMb", Value: *m.PeakMemoryMB})
	}
	if m.EfficiencyPercent != nil {
		members = append(members, jsonMember{Key: "efficiencyPercent", Value: *m.EfficiencyPercent})
	}
	return marshalOrderedJSON(members)
}

// MarshalJSON emits CrawlFailureDetail: url and statusCode are optional (an
// empty url and a nil status code are the NestJS undefined values), error and
// retryable are always present.
func (f Failure) MarshalJSON() ([]byte, error) {
	members := make([]jsonMember, 0, 4)
	if f.URL != "" {
		members = append(members, jsonMember{Key: "url", Value: f.URL})
	}
	if f.StatusCode != nil {
		members = append(members, jsonMember{Key: "statusCode", Value: *f.StatusCode})
	}
	members = append(members,
		jsonMember{Key: "error", Value: f.Message},
		jsonMember{Key: "retryable", Value: f.Retryable},
	)
	return marshalOrderedJSON(members)
}

// orderedSummaryDocument is the BSON form of FullSummary. The TaskLog data
// leaf is stored as an ordered document so the persisted summary keeps the
// NestJS member order instead of the arbitrary order a Go map encodes to.
func orderedSummaryDocument(summary FullSummary) bson.D {
	document := bson.D{
		{Key: "inserted", Value: summary.Inserted},
		{Key: "skipped", Value: summary.Skipped},
	}
	if summary.ReusedResultID != nil {
		document = append(document, bson.E{Key: "reusedResultId", Value: *summary.ReusedResultID})
	}
	if summary.ItemsQueued != nil {
		document = append(document, bson.E{Key: "itemsQueued", Value: *summary.ItemsQueued})
	}
	if summary.ItemsQueueFailed != nil {
		document = append(document, bson.E{Key: "itemsQueueFailed", Value: *summary.ItemsQueueFailed})
	}
	if summary.LastFetchedAt != nil {
		document = append(document, bson.E{Key: "lastFetchedAt", Value: *summary.LastFetchedAt})
	}
	if summary.RunID != nil {
		document = append(document, bson.E{Key: "runId", Value: *summary.RunID})
	}
	if summary.Memory != nil {
		document = append(document, bson.E{Key: "memory", Value: orderedMemoryDocument(*summary.Memory)})
	}
	if summary.Failures != nil {
		failures := make(bson.A, 0, len(summary.Failures))
		for _, failure := range summary.Failures {
			failures = append(failures, orderedFailureDocument(failure))
		}
		document = append(document, bson.E{Key: "failures", Value: failures})
	}
	if summary.RetryableFailures != nil {
		document = append(document, bson.E{Key: "retryableFailures", Value: *summary.RetryableFailures})
	}
	return document
}

// orderedMemoryDocument is the ordered BSON form of MemoryStats.
func orderedMemoryDocument(memory MemoryStats) bson.D {
	document := bson.D{}
	if memory.ServerMemoryMB != nil {
		document = append(document, bson.E{Key: "serverMemoryMb", Value: *memory.ServerMemoryMB})
	}
	if memory.PeakMemoryMB != nil {
		document = append(document, bson.E{Key: "peakMemoryMb", Value: *memory.PeakMemoryMB})
	}
	if memory.EfficiencyPercent != nil {
		document = append(document, bson.E{Key: "efficiencyPercent", Value: *memory.EfficiencyPercent})
	}
	return document
}

// orderedFailureDocument is the ordered BSON form of Failure.
func orderedFailureDocument(failure Failure) bson.D {
	document := bson.D{}
	if failure.URL != "" {
		document = append(document, bson.E{Key: "url", Value: failure.URL})
	}
	if failure.StatusCode != nil {
		document = append(document, bson.E{Key: "statusCode", Value: *failure.StatusCode})
	}
	document = append(document,
		bson.E{Key: "error", Value: failure.Message},
		bson.E{Key: "retryable", Value: failure.Retryable},
	)
	return document
}

// completeTaskLogDocument is the complete-stage TaskLog document: the same
// fields taskLogDocument writes, with the runTask summary as the ordered data
// leaf. It is pure so the member order is testable without Mongo.
func completeTaskLogDocument(jobID, orgID string, summary FullSummary, now time.Time) bson.D {
	return bson.D{
		{Key: "_id", Value: bson.NewObjectID()},
		{Key: "queue", Value: crawlQueueName},
		{Key: "jobId", Value: jobID},
		{Key: "orgId", Value: orgID},
		{Key: "stage", Value: "complete"},
		{Key: "status", Value: "completed"},
		{Key: "data", Value: orderedSummaryDocument(summary)},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	}
}

// writeCompleteTaskLog writes the complete-stage TaskLog entry whose data block
// is the runTask summary. It mirrors writeTaskLog (best effort, five second
// timeout) but keeps the summary member order by inserting an ordered document
// instead of the JSON round-tripped map writeTaskLog builds.
func (s *Service) writeCompleteTaskLog(ctx context.Context, jobID, orgID string, summary FullSummary) {
	if s == nil || s.mongo == nil {
		return
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	document := completeTaskLogDocument(jobID, orgID, summary, now)
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := s.mongo.Collection(taskLogsCollection).InsertOne(writeCtx, document); err != nil {
		log.Printf("crawlexecution: failed to persist task log queue=%s jobId=%s stage=complete: %v",
			crawlQueueName, jobID, err)
	}
}
