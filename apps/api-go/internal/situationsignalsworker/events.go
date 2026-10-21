package situationsignalsworker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RealtimeEventsChannel is the Redis pub/sub channel of the situation-monitor
// realtime bridge (contract A6). NestJS instances and the Go socket layer
// subscribe to it; the signals worker is the only publisher.
const RealtimeEventsChannel = "situation-monitor:signals:events:v1"

// RealtimeEventType enumerates the events the worker publishes.
type RealtimeEventType string

const (
	// RealtimeEventTelegramUpdate is published when a Telegram poll produced
	// new feed items.
	RealtimeEventTelegramUpdate RealtimeEventType = "situation:telegram.update"
	// RealtimeEventOrefUpdate is published when the OREF alert list changed.
	RealtimeEventOrefUpdate RealtimeEventType = "situation:oref.update"
)

// realtimeEventVersion is the envelope version every subscriber validates.
const realtimeEventVersion = 1

// RealtimeEvent is the event bridge envelope. The field order is part of the
// wire contract: version, type, payload, timestamp.
type RealtimeEvent struct {
	Version   int               `json:"version"`
	Type      RealtimeEventType `json:"type"`
	Payload   json.RawMessage   `json:"payload"`
	Timestamp string            `json:"timestamp"`
}

// EventPublisher publishes one realtime event. It is an interface so the
// worker can be tested without Redis.
type EventPublisher interface {
	Publish(ctx context.Context, event RealtimeEvent) error
}

// RedisEventPublisher publishes RealtimeEvent envelopes with Redis PUBLISH.
//
// The NestJS subscriber (situation-monitor-signals-events.subscriber.ts) parses
// the envelope, validates version 1 and emits each payload locally. Redis
// PUBLISH is fire-and-forget towards subscribers but still reports Redis
// connection errors, which the worker logs and otherwise ignores: a missed
// realtime update must never fail or delay a poll.
type RedisEventPublisher struct {
	client *redis.Client
	now    func() time.Time
}

// NewRedisEventPublisher binds the publisher to the shared go-redis client.
func NewRedisEventPublisher(client *redis.Client) *RedisEventPublisher {
	return &RedisEventPublisher{client: client, now: time.Now}
}

// Publish marshals the envelope and publishes it. The payload is already
// marshaled by the caller so its key order is under the worker's control.
func (p *RedisEventPublisher) Publish(ctx context.Context, event RealtimeEvent) error {
	if p == nil || p.client == nil {
		return fmt.Errorf("situationsignalsworker: event publisher is not configured")
	}
	if event.Timestamp == "" {
		now := p.now
		if now == nil {
			now = time.Now
		}
		event.Timestamp = now().UTC().Format(nestISOLayout)
	}
	encoded, err := marshalJSONNoEscape(event)
	if err != nil {
		return fmt.Errorf("situationsignalsworker: encode realtime event: %w", err)
	}
	if err := p.client.Publish(ctx, RealtimeEventsChannel, encoded).Err(); err != nil {
		return fmt.Errorf("situationsignalsworker: publish realtime event: %w", err)
	}
	return nil
}

// newRealtimeEvent builds the envelope for one payload, marshaling the payload
// and stamping the current instant in the ISO millisecond form NestJS writes.
func newRealtimeEvent(eventType RealtimeEventType, payload any) (RealtimeEvent, error) {
	encoded, err := marshalJSONNoEscape(payload)
	if err != nil {
		return RealtimeEvent{}, fmt.Errorf("situationsignalsworker: encode %s payload: %w", eventType, err)
	}
	return RealtimeEvent{
		Version:   realtimeEventVersion,
		Type:      eventType,
		Payload:   encoded,
		Timestamp: time.Now().UTC().Format(nestISOLayout),
	}, nil
}

// telegramUpdatePayload is the situation:telegram.update payload.
// Key order: count, updatedAt, items (NestJS object literal order).
type telegramUpdatePayload struct {
	Count     int            `json:"count"`
	UpdatedAt string         `json:"updatedAt"`
	Items     []TelegramItem `json:"items"`
}

// orefUpdatePayload is the situation:oref.update payload.
// Key order: alerts, historyCount24h, totalHistoryCount, updatedAt,
// historyEntry (NestJS object literal order). historyEntry is present as null
// when the cycle did not create one.
type orefUpdatePayload struct {
	Alerts            []json.RawMessage `json:"alerts"`
	HistoryCount24h   int               `json:"historyCount24h"`
	TotalHistoryCount int               `json:"totalHistoryCount"`
	UpdatedAt         string            `json:"updatedAt"`
	HistoryEntry      *OrefHistoryEntry `json:"historyEntry"`
}
