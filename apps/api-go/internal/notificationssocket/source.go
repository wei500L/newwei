package notificationssocket

import (
	"context"
	"fmt"
	"sync"

	"github.com/redis/go-redis/v9"
)

// feedSource abstracts the Redis relay for unit tests.
type feedSource interface {
	Start(context.Context) error
	Close() error
}

type relayHandler func(context.Context, relayKind, string)

// redisFeed subscribes to the four identifiers-only channels. A message is
// handled asynchronously so one slow MySQL re-read cannot block the Redis
// reader, but each connection still serializes its own writes.
type redisFeed struct {
	client  *redis.Client
	handle  relayHandler
	mu      sync.Mutex
	pubsub  *redis.PubSub
	cancel  context.CancelFunc
	started bool
}

func newRedisFeed(client *redis.Client, handle relayHandler) *redisFeed {
	return &redisFeed{client: client, handle: handle}
}

func (f *redisFeed) Start(parent context.Context) error {
	f.mu.Lock()
	if f.started {
		f.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	channels := make([]string, 0, len(relayChannels))
	for channel := range relayChannels {
		channels = append(channels, channel)
	}
	pubsub := f.client.Subscribe(ctx, channels...)
	if _, err := pubsub.Receive(ctx); err != nil {
		cancel()
		_ = pubsub.Close()
		f.mu.Unlock()
		return fmt.Errorf("notificationssocket: subscribe relay channels: %w", err)
	}
	f.pubsub = pubsub
	f.cancel = cancel
	f.started = true
	f.mu.Unlock()

	go func() {
		for message := range pubsub.Channel() {
			kind, ok := relayChannels[message.Channel]
			if !ok {
				continue
			}
			f.handle(ctx, kind, message.Payload)
		}
	}()
	return nil
}

func (f *redisFeed) Close() error {
	f.mu.Lock()
	pubsub := f.pubsub
	cancel := f.cancel
	f.pubsub = nil
	f.cancel = nil
	f.started = false
	f.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if pubsub != nil {
		return pubsub.Close()
	}
	return nil
}
