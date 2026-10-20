package graphqlsubscriptions

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	channelPrefix    = "gqlsub:"
	feedBuffer       = 64
	busChannelBuffer = 1024
)

var errSubscriptionsClosed = errors.New("graphqlsubscriptions: bus is closed")

type busFeed struct {
	channel chan FeedEvent
}

// Bus reads the three existing gqlsub:* Redis channels on one dedicated
// pub/sub connection. Local subscribers are indexed by (channel, orgId), so a
// message is decoded and compared against the authenticated org once and only
// that organization's operations are projected. Redis pub/sub is not durable:
// a reconnect or a slow subscriber can miss an event instead of replaying it.
type Bus struct {
	client *redis.Client
	pubsub *redis.PubSub

	mu      sync.Mutex
	feeds   map[string]map[string]map[*busFeed]struct{}
	counts  map[string]int
	closing bool

	startOnce sync.Once
	readerWG  sync.WaitGroup
}

// NewBus returns a bus that will read through sharedClient. The pub/sub
// connection itself is created by Start and is never the shared command
// client (a subscribed Redis connection cannot run commands).
func NewBus(sharedClient *redis.Client) *Bus {
	return &Bus{
		client: sharedClient,
		feeds:  map[string]map[string]map[*busFeed]struct{}{},
		counts: map[string]int{},
	}
}

// Start creates the pub/sub connection and the single message reader. It is
// safe to call once; a second call is a no-op.
func (b *Bus) Start(_ context.Context) {
	if b == nil || b.client == nil {
		return
	}
	b.mu.Lock()
	if b.closing {
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	b.startOnce.Do(func() {
		pubsub := b.client.Subscribe(context.Background())
		b.mu.Lock()
		b.pubsub = pubsub
		b.readerWG.Add(1)
		b.mu.Unlock()
		go func() {
			defer b.readerWG.Done()
			b.readLoop()
		}()
	})
}

func (b *Bus) readLoop() {
	if b.pubsub == nil {
		return
	}
	messages := b.pubsub.Channel(redis.WithChannelSize(busChannelBuffer))
	for message := range messages {
		if message == nil {
			continue
		}
		b.handle(message.Channel, []byte(message.Payload))
	}
}

func (b *Bus) handle(channel string, payload []byte) {
	root := strings.TrimPrefix(channel, channelPrefix)
	if root == channel || !validSubscriptionRoot(root) {
		return
	}
	event, ok := decodeFeedEvent(root, payload)
	if !ok || event.OrgID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closing {
		return
	}
	// Exact organization comparison: never trim an envelope orgId into a
	// different tenant and never broadcast globally.
	for feed := range b.feeds[channel][event.OrgID] {
		select {
		case feed.channel <- event:
		default:
			// Bounded per-operation queue: a slow connection loses this live
			// event rather than growing memory or blocking other tenants.
			log.Printf("graphqlsubscriptions: dropping %s event for a slow subscriber", root)
		}
	}
}

// Subscribe registers one organization-scoped feed. The Redis SUBSCRIBE is
// issued for the first local listener of the channel and the last cancellation
// unsubscribes it again.
func (b *Bus) Subscribe(ctx context.Context, root, orgID string) (<-chan FeedEvent, error) {
	if b == nil || b.client == nil || !validSubscriptionRoot(root) {
		return nil, errSubscriptionsClosed
	}
	channel := channelPrefix + root
	feed := &busFeed{channel: make(chan FeedEvent, feedBuffer)}

	b.mu.Lock()
	if b.closing || b.pubsub == nil {
		b.mu.Unlock()
		return nil, errSubscriptionsClosed
	}
	if b.feeds[channel] == nil {
		b.feeds[channel] = map[string]map[*busFeed]struct{}{}
	}
	if b.feeds[channel][orgID] == nil {
		b.feeds[channel][orgID] = map[*busFeed]struct{}{}
	}
	b.feeds[channel][orgID][feed] = struct{}{}
	first := b.counts[channel] == 0
	b.counts[channel]++
	b.mu.Unlock()

	if first {
		subscribeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := b.pubsub.Subscribe(subscribeCtx, channel)
		cancel()
		if err != nil {
			b.release(channel, orgID, feed)
			return nil, err
		}
	}
	go func() {
		<-ctx.Done()
		b.release(channel, orgID, feed)
	}()
	return feed.channel, nil
}

func (b *Bus) release(channel, orgID string, feed *busFeed) {
	b.mu.Lock()
	orgs := b.feeds[channel]
	if orgs == nil {
		b.mu.Unlock()
		return
	}
	feeds := orgs[orgID]
	if feeds == nil {
		b.mu.Unlock()
		return
	}
	if _, ok := feeds[feed]; !ok {
		b.mu.Unlock()
		return
	}
	delete(feeds, feed)
	if len(feeds) == 0 {
		delete(orgs, orgID)
	}
	b.counts[channel]--
	empty := b.counts[channel] <= 0
	if empty {
		delete(b.counts, channel)
		delete(b.feeds, channel)
	}
	close(feed.channel)
	closing := b.closing
	b.mu.Unlock()

	if empty && !closing && b.pubsub != nil {
		unsubscribeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if err := b.pubsub.Unsubscribe(unsubscribeCtx, channel); err != nil {
			log.Printf("graphqlsubscriptions: Redis unsubscribe %s: %v", channel, err)
		}
		cancel()
	}
}

// Close stops new feeds, closes every local feed, closes the pub/sub
// connection and waits briefly for the reader to observe the close.
func (b *Bus) Close(ctx context.Context) error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	if b.closing {
		b.mu.Unlock()
	} else {
		b.closing = true
		for _, orgs := range b.feeds {
			for _, feeds := range orgs {
				for feed := range feeds {
					close(feed.channel)
				}
			}
		}
		b.feeds = map[string]map[string]map[*busFeed]struct{}{}
		b.counts = map[string]int{}
		b.mu.Unlock()
	}
	if b.pubsub != nil {
		if err := b.pubsub.Close(); err != nil {
			log.Printf("graphqlsubscriptions: Redis pubsub close: %v", err)
		}
	}
	done := make(chan struct{})
	go func() {
		b.readerWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
