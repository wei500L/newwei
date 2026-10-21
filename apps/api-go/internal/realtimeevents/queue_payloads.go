package realtimeevents

import (
	"encoding/json"
)

// Wire payloads of the queue/ops/quality namespaces.
//
// The field order is the NestJS object literal order after the owning gateway
// prepends orgId. Optional fields are omitted when empty, matching the JS
// `...(value ? {key: value} : {})` spreads (an absent data key stays absent).
// The JSON bytes are forwarded unchanged by realtimesocket.

// queueEventWirePayload is `queue:event` = {orgId, ...QueueEventPayload}.
type queueEventWirePayload struct {
	OrgID           string          `json:"orgId"`
	Event           string          `json:"event"`
	JobID           string          `json:"jobId"`
	Data            json.RawMessage `json:"data,omitempty"`
	Timestamp       string          `json:"timestamp"`
	PipelineJobID   string          `json:"pipelineJobId,omitempty"`
	SourceID        string          `json:"sourceId,omitempty"`
	RawItemID       string          `json:"rawItemId,omitempty"`
	ItemMetaID      string          `json:"itemMetaId,omitempty"`
	ProcessedItemID string          `json:"processedItemId,omitempty"`
}

// opsEventWirePayload is `ops:event`: the five-source matrix of the NestJS Ops
// gateway. Pipeline events fill the pipeline identifiers; crawl events fill the
// crawl identifiers; analysis/assistant/alerts only carry the common fields.
type opsEventWirePayload struct {
	OrgID           string          `json:"orgId"`
	Source          string          `json:"source"`
	Event           string          `json:"event"`
	JobID           string          `json:"jobId"`
	Data            json.RawMessage `json:"data,omitempty"`
	Timestamp       string          `json:"timestamp"`
	PipelineJobID   string          `json:"pipelineJobId,omitempty"`
	SourceID        string          `json:"sourceId,omitempty"`
	RawItemID       string          `json:"rawItemId,omitempty"`
	ItemMetaID      string          `json:"itemMetaId,omitempty"`
	ProcessedItemID string          `json:"processedItemId,omitempty"`
	TaskID          string          `json:"taskId,omitempty"`
	PriorityClass   string          `json:"priorityClass,omitempty"`
	SourcePriority  *int            `json:"sourcePriority,omitempty"`
}

// qualityEventWirePayload is `quality:event`: exactly five fields, never data.
type qualityEventWirePayload struct {
	OrgID     string `json:"orgId"`
	Source    string `json:"source"`
	Event     string `json:"event"`
	JobID     string `json:"jobId"`
	Timestamp string `json:"timestamp"`
}

// buildQueueEventPayload encodes the queue:event payload for one pipeline
// event. The queue namespace only carries itemPipeline events.
func buildQueueEventPayload(resolved queueContext, event, jobID string, data json.RawMessage, hasData bool, timestamp string) (json.RawMessage, error) {
	payload := queueEventWirePayload{
		OrgID:           resolved.OrgID,
		Event:           event,
		JobID:           jobID,
		Timestamp:       timestamp,
		PipelineJobID:   resolved.PipelineJobID,
		SourceID:        resolved.SourceID,
		RawItemID:       resolved.RawItemID,
		ItemMetaID:      resolved.ItemMetaID,
		ProcessedItemID: resolved.ProcessedItemID,
	}
	if hasData {
		payload.Data = data
	}
	return json.Marshal(payload)
}

// buildOpsEventPayload encodes the ops:event payload for one event of source.
func buildOpsEventPayload(source string, resolved queueContext, event, jobID string, data json.RawMessage, hasData bool, timestamp string) (json.RawMessage, error) {
	payload := opsEventWirePayload{
		OrgID:           resolved.OrgID,
		Source:          source,
		Event:           event,
		JobID:           jobID,
		Timestamp:       timestamp,
		PipelineJobID:   resolved.PipelineJobID,
		SourceID:        resolved.SourceID,
		RawItemID:       resolved.RawItemID,
		ItemMetaID:      resolved.ItemMetaID,
		ProcessedItemID: resolved.ProcessedItemID,
		TaskID:          resolved.TaskID,
		PriorityClass:   resolved.PriorityClass,
		SourcePriority:  resolved.SourcePriority,
	}
	if hasData {
		payload.Data = data
	}
	return json.Marshal(payload)
}

// buildQualityEventPayload encodes the quality:event payload (no data, no
// extended fields).
func buildQualityEventPayload(source, orgID, event, jobID, timestamp string) (json.RawMessage, error) {
	return json.Marshal(qualityEventWirePayload{
		OrgID:     orgID,
		Source:    source,
		Event:     event,
		JobID:     jobID,
		Timestamp: timestamp,
	})
}
