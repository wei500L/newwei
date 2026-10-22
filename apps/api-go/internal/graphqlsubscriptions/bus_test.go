package graphqlsubscriptions

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// fakePubSub is a pubSubConnection with scripted SUBSCRIBE failures. It lets
// the bus bookkeeping and the organization routing be tested without a Redis
// server.
type fakePubSub struct {
	mu         sync.Mutex
	failures   []error
	subscribed map[string]bool
	subscribes int
	messages   chan *redis.Message
	closed     bool
}

func newFakePubSub(failures ...error) *fakePubSub {
	return &fakePubSub{
		failures:   failures,
		subscribed: map[string]bool{},
		messages:   make(chan *redis.Message, 8),
	}
}

func (f *fakePubSub) Subscribe(_ context.Context, channels ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subscribes++
	if len(f.failures) > 0 {
		err := f.failures[0]
		f.failures = f.failures[1:]
		return err
	}
	for _, channel := range channels {
		f.subscribed[channel] = true
	}
	return nil
}

func (f *fakePubSub) Unsubscribe(_ context.Context, channels ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, channel := range channels {
		delete(f.subscribed, channel)
	}
	return nil
}

func (f *fakePubSub) Channel(...redis.ChannelOption) <-chan *redis.Message {
	return f.messages
}

func (f *fakePubSub) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.messages)
	}
	return nil
}

func (f *fakePubSub) subscribeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subscribes
}

func (f *fakePubSub) isSubscribed(channel string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subscribed[channel]
}

// deliver publishes one Redis message to the reader loop.
func (f *fakePubSub) deliver(channel, payload string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.messages <- &redis.Message{Channel: channel, Payload: payload}
}

// startFakeBus wires a Bus to a ready fake connection and closes it on cleanup.
func startFakeBus(t *testing.T, connection *fakePubSub) *Bus {
	t.Helper()
	bus := NewBus(nil)
	bus.pubsub = connection
	bus.Start(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := bus.Close(ctx); err != nil {
			t.Fatalf("close bus: %v", err)
		}
	})
	return bus
}

const alertEventPayloadOrgA = `{"orgId":"org-a","event":{"id":"event-1","severity":"warning","status":"delivered","triggeredAt":"2026-03-15T12:00:00.000Z"}}`

// A failed SUBSCRIBE must not leave a live local feed: the next listener has to
// issue the command again instead of assuming the channel is subscribed.
func TestBusResubscribesAfterSubscribeFailure(t *testing.T) {
	connection := newFakePubSub(errors.New("redis unavailable"))
	bus := startFakeBus(t, connection)

	failedCtx, failedCancel := context.WithCancel(context.Background())
	defer failedCancel()
	if _, err := bus.Subscribe(failedCtx, "alertEvents", "org-a"); err == nil {
		t.Fatal("expected the first subscribe to fail")
	}
	if got := connection.subscribeCount(); got != 1 {
		t.Fatalf("subscribe calls = %d, want 1", got)
	}
	if connection.isSubscribed(channelPrefix + "alertEvents") {
		t.Fatal("the fake connection must not report a subscription after the failure")
	}

	feedCtx, feedCancel := context.WithCancel(context.Background())
	defer feedCancel()
	feed, err := bus.Subscribe(feedCtx, "alertEvents", "org-a")
	if err != nil {
		t.Fatalf("second subscribe: %v", err)
	}
	if got := connection.subscribeCount(); got != 2 {
		t.Fatalf("subscribe calls = %d, want 2 (the failed channel must be retried)", got)
	}
	if !connection.isSubscribed(channelPrefix + "alertEvents") {
		t.Fatal("the retried subscribe did not reach the connection")
	}

	connection.deliver(channelPrefix+"alertEvents", alertEventPayloadOrgA)
	select {
	case event := <-feed:
		if event.OrgID != "org-a" {
			t.Fatalf("orgId = %q, want org-a", event.OrgID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no event delivered after the retried subscribe")
	}
}

// One channel subscription serves every organization, and an envelope is only
// routed to the operation of the organization it names.
func TestBusRoutesOnlyToTheMatchingOrganization(t *testing.T) {
	connection := newFakePubSub()
	bus := startFakeBus(t, connection)

	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	feedA, err := bus.Subscribe(ctxA, "alertEvents", "org-a")
	if err != nil {
		t.Fatalf("subscribe org-a: %v", err)
	}
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	feedB, err := bus.Subscribe(ctxB, "alertEvents", "org-b")
	if err != nil {
		t.Fatalf("subscribe org-b: %v", err)
	}
	if got := connection.subscribeCount(); got != 1 {
		t.Fatalf("subscribe calls = %d, want 1 for two organizations of one channel", got)
	}

	connection.deliver(channelPrefix+"alertEvents", alertEventPayloadOrgA)
	select {
	case event := <-feedA:
		if event.OrgID != "org-a" {
			t.Fatalf("orgId = %q, want org-a", event.OrgID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("org-a did not receive its event")
	}
	select {
	case event := <-feedB:
		t.Fatalf("org-b received another organization's event: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
}

// A malformed envelope and an envelope without orgId are dropped instead of
// being broadcast to every local operation.
func TestBusDropsMalformedAndUnscopedEnvelopes(t *testing.T) {
	connection := newFakePubSub()
	bus := startFakeBus(t, connection)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, err := bus.Subscribe(ctx, "analysisEvents", "org-a")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	connection.deliver(channelPrefix+"analysisEvents", `{"orgId":`)
	connection.deliver(channelPrefix+"analysisEvents", `{"orgId":"","result":{"id":"r1"}}`)
	connection.deliver("gqlsub:unknownRoot", `{"orgId":"org-a"}`)
	select {
	case event := <-feed:
		t.Fatalf("unexpected delivery: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
}
