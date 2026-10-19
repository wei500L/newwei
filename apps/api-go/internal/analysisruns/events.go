package analysisruns

// This file publishes the existing gqlsub:analysisEvents envelope. Delivery is
// best effort; Mongo/MySQL remain the durable result.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// AnalysisEventsChannel is the existing NestJS GraphQL subscription channel.
// The payload is the same envelope the analysis resolver's withFilter reads:
// {orgId, result:{id,type,status,summary?,error?,createdAt}}. createdAt is
// already an ISO string here, so the $gqlDate codec tag is not used.
const AnalysisEventsChannel = "gqlsub:analysisEvents"

// AnalysisEvent is the exact published envelope.
type AnalysisEvent struct {
	OrgID  string              `json:"orgId"`
	Result AnalysisEventResult `json:"result"`
}

// AnalysisEventResult is the result object. Pointer fields distinguish an
// undefined property (omitted) from an explicit null, matching JSON.stringify.
type AnalysisEventResult struct {
	ID        string  `json:"id"`
	Type      Type    `json:"type"`
	Status    Status  `json:"status"`
	Summary   *string `json:"summary,omitempty"`
	Error     *string `json:"error,omitempty"`
	CreatedAt string  `json:"createdAt"`
}

// EventPublisher publishes analysisEvents to the Redis backplane. Delivery is
// best effort: the persisted Mongo/MySQL state is the durable result, and a
// publish failure never fails the analysis run.
type EventPublisher struct {
	client *redis.Client
}

// NewEventPublisher builds the publisher over the shared Redis client.
func NewEventPublisher(client *redis.Client) *EventPublisher {
	return &EventPublisher{client: client}
}

// Publish sends one event. summary/error are optional; createdAt must be the
// record's original creation time, never the current chunk time.
func (p *EventPublisher) Publish(
	ctx context.Context,
	orgID string,
	id string,
	analysisType Type,
	status Status,
	summary *string,
	errText *string,
	createdAt time.Time,
) error {
	if p == nil || p.client == nil {
		return fmt.Errorf("analysisruns: redis is not configured")
	}
	event := AnalysisEvent{
		OrgID: orgID,
		Result: AnalysisEventResult{
			ID:        id,
			Type:      analysisType,
			Status:    status,
			Summary:   summary,
			Error:     errText,
			CreatedAt: isoString(createdAt),
		},
	}
	encoded, err := marshalNoHTMLEscape(event)
	if err != nil {
		return fmt.Errorf("analysisruns: encode analysis event: %w", err)
	}
	if err := p.client.Publish(ctx, AnalysisEventsChannel, encoded).Err(); err != nil {
		return fmt.Errorf("analysisruns: publish analysis event: %w", err)
	}
	return nil
}

// marshalNoHTMLEscape mirrors JSON.stringify: <, > and & are not escaped.
func marshalNoHTMLEscape[T any](value T) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return trimTrailingNewline(buffer.String()), nil
}
