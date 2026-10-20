//go:build integration

package assistantruns

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// TestPublisherRawMessageMatchesNestEnvelope asserts the exact Redis envelope
// GraphqlSubscriptionBus.forDomain(createAssistantPubSub) writes: channel
// gqlsub:assistantEvents and the JSON.stringify object literal order, with
// absent summary/error keys dropped.
func TestPublisherRawMessageMatchesNestEnvelope(t *testing.T) {
	addr := os.Getenv("API_GO_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	subscriber := client.Subscribe(ctx, subscriptionChannel)
	defer subscriber.Close()
	if _, err := subscriber.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	publisher := NewRedisPublisher(client)
	createdAt := "2026-10-20T00:00:00.000Z"
	if err := publisher.PublishAssistant(ctx, AssistantEvent{
		OrgID: "org-1",
		Run: AssistantRunRef{
			ID:        "run-1",
			Type:      "query",
			Status:    "running",
			CreatedAt: createdAt,
		},
	}); err != nil {
		t.Fatal(err)
	}
	message, err := subscriber.ReceiveMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"orgId":"org-1","run":{"id":"run-1","type":"query","status":"running","createdAt":"2026-10-20T00:00:00.000Z"}}`
	if message.Channel != subscriptionChannel || message.Payload != want {
		t.Fatalf("channel=%q payload=%s", message.Channel, message.Payload)
	}

	summary := "done"
	errMessage := "boom"
	if err := publisher.PublishAssistant(ctx, AssistantEvent{
		OrgID: "org-1",
		Run: AssistantRunRef{
			ID:        "run-2",
			Type:      "report",
			Status:    "failed",
			Summary:   &summary,
			Error:     &errMessage,
			CreatedAt: createdAt,
		},
	}); err != nil {
		t.Fatal(err)
	}
	message, err = subscriber.ReceiveMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want = `{"orgId":"org-1","run":{"id":"run-2","type":"report","status":"failed","summary":"done","error":"boom","createdAt":"2026-10-20T00:00:00.000Z"}}`
	if message.Payload != want {
		t.Fatalf("payload=%s", message.Payload)
	}
}
