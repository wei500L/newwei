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

	// busSubscribeTimeout and busUnsubscribeTimeout bound the SUBSCRIBE and
	// UNSUBSCRIBE round trips issued while subLock is held.
	busSubscribeTimeout   = 5 * time.Second
	busUnsubscribeTimeout = 2 * time.Second
)

var errSubscriptionsClosed = errors.New("graphqlsubscriptions: bus is closed")

type busFeed struct {
	channel chan FeedEvent
}

// pubSubConnection is the Redis pub/sub surface the bus needs. *redis.PubSub
// implements it; tests substitute a fake to exercise subscribe/reconnect
// bookkeeping without a Redis server.
type pubSubConnection interface {
	Subscribe(ctx context.Context, channels ...string) error
	Unsubscribe(ctx context.Context, channels ...string) error
	Channel(opts ...redis.ChannelOption) <-chan *redis.Message
	Close() error
}

// Bus reads the three existing gqlsub:* Redis channels on one dedicated
// pub/sub connection. Local subscribers are indexed by (channel, orgId), so a
// message is decoded and compared against the authenticated org once and only
// that organization's operations are projected. Redis pub/sub is not durable:
// a reconnect or a slow subscriber can miss an event instead of replaying it.
type Bus struct {
	client *redis.Client
	pubsub pubSubConnection

	mu     sync.Mutex
	feeds  map[string]map[string]map[*busFeed]struct{}
	counts map[string]int
	// subscribed records the channels this process actually subscribed on the
	// current connection. A failed SUBSCRIBE must not leave a live local feed
	// that never receives messages, so the state is tracked instead of being
	// inferred from the listener count.
	subscribed map[string]bool
	closing    bool

	// subLock serializes the Redis SUBSCRIBE/UNSUBSCRIBE round trips so two
	// first listeners cannot race into "one subscribed, one assumed subscribed".
	subLock sync.Mutex

	startOnce sync.Once
	readerWG  sync.WaitGroup
}

// NewBus returns a bus that will read through sharedClient. The pub/sub
// connection itself is created by Start and is never the shared command
// client (a subscribed Redis connection cannot run commands).
func NewBus(sharedClient *redis.Client) *Bus {
	return &Bus{
		client:     sharedClient,
		feeds:      map[string]map[string]map[*busFeed]struct{}{},
		counts:     map[string]int{},
		subscribed: map[string]bool{},
	}
}

// Start creates the pub/sub connection and the single message reader. It is
// safe to call once; a second call is a no-op.
func (b *Bus) Start(_ context.Context) {
	if b == nil || (b.client == nil && b.pubsub == nil) {
		return
	}
	b.mu.Lock()
	if b.closing {
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	b.startOnce.Do(func() {
		b.mu.Lock()
		connection := b.pubsub
		b.mu.Unlock()
		if connection == nil {
			connection = b.client.Subscribe(context.Background())
			b.mu.Lock()
			b.pubsub = connection
			b.mu.Unlock()
		}
		b.readerWG.Add(1)
		go func() {
			defer b.readerWG.Done()
			b.readLoop()
		}()
	})
}

func (b *Bus) readLoop() {
	b.mu.Lock()
	connection := b.pubsub
	b.mu.Unlock()
	if connection == nil {
		return
	}
	messages := connection.Channel(redis.WithChannelSize(busChannelBuffer))
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
//
// The local registration and the SUBSCRIBE decision share subLock so a
// concurrent last-cancellation cannot UNSUBSCRIBE between the decision and the
// command, and so a failed command stays visible: the flag that records the live
// subscription is only set before the command and reverted when it fails, which
// makes the next listener retry instead of assuming a subscription it never
// issued.
func (b *Bus) Subscribe(ctx context.Context, root, orgID string) (<-chan FeedEvent, error) {
	if b == nil || !validSubscriptionRoot(root) {
		return nil, errSubscriptionsClosed
	}
	channel := channelPrefix + root
	feed := &busFeed{channel: make(chan FeedEvent, feedBuffer)}

	b.subLock.Lock()
	b.mu.Lock()
	if b.closing || b.pubsub == nil {
		b.mu.Unlock()
		b.subLock.Unlock()
		return nil, errSubscriptionsClosed
	}
	if b.feeds[channel] == nil {
		b.feeds[channel] = map[string]map[*busFeed]struct{}{}
	}
	if b.feeds[channel][orgID] == nil {
		b.feeds[channel][orgID] = map[*busFeed]struct{}{}
	}
	b.feeds[channel][orgID][feed] = struct{}{}
	b.counts[channel]++
	subscribe := !b.subscribed[channel]
	if subscribe {
		b.subscribed[channel] = true
	}
	connection := b.pubsub
	b.mu.Unlock()

	if subscribe {
		subscribeCtx, cancel := context.WithTimeout(context.Background(), busSubscribeTimeout)
		err := connection.Subscribe(subscribeCtx, channel)
		cancel()
		if err != nil {
			b.mu.Lock()
			delete(b.subscribed, channel)
			b.mu.Unlock()
			b.subLock.Unlock()
			b.release(channel, orgID, feed)
			return nil, err
		}
	}
	b.subLock.Unlock()

	go func() {
		<-ctx.Done()
		b.release(channel, orgID, feed)
	}()
	return feed.channel, nil
}

func (b *Bus) release(channel, orgID string, feed *busFeed) {
	b.subLock.Lock()
	b.mu.Lock()
	orgs := b.feeds[channel]
	if orgs == nil {
		b.mu.Unlock()
		b.subLock.Unlock()
		return
	}
	feeds := orgs[orgID]
	if feeds == nil {
		b.mu.Unlock()
		b.subLock.Unlock()
		return
	}
	if _, ok := feeds[feed]; !ok {
		b.mu.Unlock()
		b.subLock.Unlock()
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
	unsubscribe := empty && b.subscribed[channel] && !b.closing
	if unsubscribe {
		// The channel is only marked as not subscribed together with the
		// decision, so the next listener re-issues the SUBSCRIBE.
		delete(b.subscribed, channel)
	}
	connection := b.pubsub
	close(feed.channel)
	b.mu.Unlock()

	if unsubscribe && connection != nil {
		unsubscribeCtx, cancel := context.WithTimeout(context.Background(), busUnsubscribeTimeout)
		if err := connection.Unsubscribe(unsubscribeCtx, channel); err != nil {
			log.Printf("graphqlsubscriptions: Redis unsubscribe %s: %v", channel, err)
		}
		cancel()
	}
	b.subLock.Unlock()
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
		b.subscribed = map[string]bool{}
		b.mu.Unlock()
	}
	b.mu.Lock()
	connection := b.pubsub
	b.mu.Unlock()
	if connection != nil {
		if err := connection.Close(); err != nil {
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
