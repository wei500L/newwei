package assistantruns

import (
	"bytes"
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// subscriptionChannel is GraphqlSubscriptionBus.channel("assistantEvents"):
// the "gqlsub:" prefix plus the trigger name. NestJS and the #95 Go
// subscription transport both subscribe to this exact channel.
const subscriptionChannel = "gqlsub:assistantEvents"

// Publisher emits assistantEvents. Implementations must not fail the run when
// delivery fails: NestJS logs the delivery failure and keeps the persisted row.
type Publisher interface {
	PublishAssistant(ctx context.Context, event AssistantEvent) error
}

// RedisPublisher publishes the GraphqlSubscriptionBus envelope.
type RedisPublisher struct {
	redis *redis.Client
}

// NewRedisPublisher binds the publisher to the shared Redis client.
func NewRedisPublisher(client *redis.Client) *RedisPublisher {
	return &RedisPublisher{redis: client}
}

// PublishAssistant encodes {orgId,run:{id,type,status,summary,error,createdAt}}
// exactly like encodeGraphqlSubscriptionPayload: JSON.stringify semantics,
// which drops absent summary/error keys and keeps the object-literal field
// order. HTML escaping is disabled because JSON.stringify does not escape
// <, > or &.
func (p *RedisPublisher) PublishAssistant(ctx context.Context, event AssistantEvent) error {
	if p == nil || p.redis == nil {
		log.Printf("api-go: assistant event %s was not delivered: redis is not configured", event.Run.ID)
		return nil
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		log.Printf("api-go: assistant event %s was not encoded: %v", event.Run.ID, err)
		return nil
	}
	payload := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	if err := p.redis.Publish(ctx, subscriptionChannel, payload).Err(); err != nil {
		log.Printf("api-go: assistant event %s delivery failed: %v", event.Run.ID, err)
	}
	return nil
}
