package realtimeevents

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Newsnow event sources.
//
// newsnow:update reaches the browser through two input paths and one output
// path. The inputs are the Socket.IO Redis adapter broadcast channel (NestJS
// gateway / dispatcher productions) and the newsnow:source-refresh:v1 relay
// published by the Go source fetch unit. The output is always a local push;
// for the relay path this process also republishes one adapter broadcast on the
// org room channel so that every instance in a mixed deployment (and the
// NestJS sockets, if any) observes the update exactly once.

const (
	newsnowSourceRefreshChannel = "newsnow:source-refresh:v1"
	newsnowUpdateEvent          = "newsnow:update"
	newsnowSetActiveSources     = "newsnow:set-active-sources"
	maxNewsnowTopTitles         = 3
	newsnowFanoutTTL            = 60 * time.Second
)

// newsnowUpdatePayload is the browser wire payload. The field order is the
// NestJS order (orgId, sourceId, newItemsCount, topTitles, updatedTime,
// intervalMs, timestamp) and must not change: the JSON bytes are forwarded
// unchanged by realtimesocket. The msgpack tags keep the Redis adapter copy
// byte-compatible with a NestJS emit; without them notepack would encode the Go
// field names and every other instance would deliver the wrong keys.
type newsnowUpdatePayload struct {
	OrgID         string   `json:"orgId" msgpack:"orgId"`
	SourceID      string   `json:"sourceId" msgpack:"sourceId"`
	NewItemsCount float64  `json:"newItemsCount" msgpack:"newItemsCount"`
	TopTitles     []string `json:"topTitles" msgpack:"topTitles"`
	UpdatedTime   string   `json:"updatedTime" msgpack:"updatedTime"`
	IntervalMs    float64  `json:"intervalMs" msgpack:"intervalMs"`
	Timestamp     string   `json:"timestamp" msgpack:"timestamp"`
}

// strictNumber is a JSON number that rejects null, strings, booleans and
// non-finite values, matching the NestJS `typeof x === "number" &&
// Number.isFinite(x)` guards.
type strictNumber float64

func (n *strictNumber) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return fmt.Errorf("realtimeevents: value is not a number")
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return fmt.Errorf("realtimeevents: value is not a number: %w", err)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fmt.Errorf("realtimeevents: value is not finite")
	}
	*n = strictNumber(value)
	return nil
}

// sourceRefreshMessage is the newsnow:source-refresh:v1 relay document.
type sourceRefreshMessage struct {
	Version       int             `json:"version"`
	RefreshID     string          `json:"refreshId"`
	SourceID      string          `json:"sourceId"`
	NewItemsCount strictNumber    `json:"newItemsCount"`
	UpdatedTime   string          `json:"updatedTime"`
	IntervalMs    strictNumber    `json:"intervalMs"`
	TopTitles     json.RawMessage `json:"topTitles"`
}

// parseSourceRefresh mirrors NewsnowSourceRefreshSubscriber.parseMessage. A
// half-filled document is dropped instead of being partially used.
func parseSourceRefresh(raw []byte) (sourceRefreshMessage, []string, bool) {
	var message sourceRefreshMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return sourceRefreshMessage{}, nil, false
	}
	if message.Version != 1 {
		return sourceRefreshMessage{}, nil, false
	}
	if strings.TrimSpace(message.RefreshID) == "" || strings.TrimSpace(message.SourceID) == "" {
		return sourceRefreshMessage{}, nil, false
	}
	newItemsCount := float64(message.NewItemsCount)
	if !isFinite(newItemsCount) || newItemsCount <= 0 {
		return sourceRefreshMessage{}, nil, false
	}
	if strings.TrimSpace(message.UpdatedTime) == "" {
		return sourceRefreshMessage{}, nil, false
	}
	if !isFinite(float64(message.IntervalMs)) {
		return sourceRefreshMessage{}, nil, false
	}
	// topTitles must be present and a JSON array; an empty array is valid (the
	// Go fetch unit publishes `[]` when every new title trimmed to empty), while
	// a missing key, null or any non-array value is rejected.
	if len(message.TopTitles) == 0 {
		return sourceRefreshMessage{}, nil, false
	}
	trimmedTitles := strings.TrimSpace(string(message.TopTitles))
	if trimmedTitles == "null" {
		return sourceRefreshMessage{}, nil, false
	}
	var rawTitles []json.RawMessage
	if err := json.Unmarshal([]byte(trimmedTitles), &rawTitles); err != nil {
		return sourceRefreshMessage{}, nil, false
	}
	titles := make([]string, 0, maxNewsnowTopTitles)
	for _, entry := range rawTitles {
		if len(titles) >= maxNewsnowTopTitles {
			break
		}
		var title string
		if err := json.Unmarshal(entry, &title); err != nil {
			continue
		}
		titles = append(titles, title)
	}
	return message, titles, true
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// openNewsnowSubscriptions creates both newsnow readers. The pattern
// subscription covers the base channel and every single-room channel of the
// namespace; request/response channels are never subscribed.
func (s *Sources) openNewsnowSubscriptions(ctx context.Context) error {
	client := s.newSubscriptionClient()
	pattern := adapterPattern(s.options.AdapterKey, NamespaceNewsnow)
	adapterSub, err := s.subscribePattern(ctx, client, pattern)
	if err != nil {
		return err
	}
	s.adapterSub = adapterSub
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.readPubSub(ctx, adapterSub, s.handleAdapterBroadcast)
	}()

	refreshSub, err := s.subscribeChannel(ctx, client, newsnowSourceRefreshChannel)
	if err != nil {
		_ = adapterSub.Close()
		return err
	}
	s.refreshSub = refreshSub
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.readPubSub(ctx, refreshSub, func(_ string, payload []byte) {
			s.handleSourceRefresh(ctx, payload)
		})
	}()
	return nil
}

// handleAdapterBroadcast decodes one Redis adapter message and pushes the event
// to the local sessions selected by opts.rooms/opts.except. The event name and
// payload are forwarded unchanged (payload keeps the msgpack map order).
func (s *Sources) handleAdapterBroadcast(channel string, payload []byte) {
	message, err := decodeAdapterMessage(payload)
	if err != nil {
		log.Printf("realtimeevents: dropping malformed newsnow adapter message on %q: %v", channel, err)
		return
	}
	if message.UID == s.uid {
		return
	}
	if message.Namespace != NamespaceNewsnow {
		return
	}
	sink := s.sinkSnapshot()
	if sink == nil {
		return
	}
	rooms := message.Rooms
	if len(rooms) == 0 {
		if room := adapterMessageChannelRoom(channel, s.options.AdapterKey, NamespaceNewsnow); room != "" {
			rooms = []string{room}
		}
	}
	sink.PublishRooms(NamespaceNewsnow, rooms, message.Except, message.Event, message.PayloadJSON)
}

// handleSourceRefresh turns one Go fetch relay message into an adapter
// broadcast plus a local push. The NX claim elects exactly one instance per
// (refreshId, organization), matching the NestJS subscriber, so a mixed
// deployment delivers a refresh exactly once.
func (s *Sources) handleSourceRefresh(ctx context.Context, raw []byte) {
	message, topTitles, ok := parseSourceRefresh(raw)
	if !ok {
		// The NestJS subscriber silently ignores malformed relay messages; keep
		// one debug line instead of dropping without a trace.
		log.Printf("realtimeevents: ignoring malformed %s relay message", newsnowSourceRefreshChannel)
		return
	}
	orgIDs := s.newsnow.orgIDsForSource(message.SourceID)
	if len(orgIDs) == 0 {
		return
	}
	sink := s.sinkSnapshot()
	if sink == nil || s.redisOps == nil {
		return
	}
	intervalMs := math.Max(1000, float64(message.IntervalMs))
	timestamp := formatISOMillis(s.now())
	for _, orgID := range orgIDs {
		claimKey := "newsnow:source-refresh:fanout:" + message.RefreshID + ":" + orgID
		acquired, err := s.redisOps.Claim(ctx, claimKey, newsnowFanoutTTL)
		if err != nil {
			log.Printf("realtimeevents: newsnow fanout claim failed for org %s: %v", orgID, err)
			continue
		}
		if !acquired {
			continue
		}
		update := newsnowUpdatePayload{
			OrgID:         orgID,
			SourceID:      message.SourceID,
			NewItemsCount: float64(message.NewItemsCount),
			TopTitles:     topTitles,
			UpdatedTime:   message.UpdatedTime,
			IntervalMs:    intervalMs,
			Timestamp:     timestamp,
		}
		payloadJSON, err := json.Marshal(update)
		if err != nil {
			log.Printf("realtimeevents: encode newsnow update failed for org %s: %v", orgID, err)
			continue
		}
		encoded, err := encodeAdapterBroadcast(s.uid, NamespaceNewsnow, []string{"org:" + orgID}, nil, newsnowUpdateEvent, update)
		if err != nil {
			log.Printf("realtimeevents: encode newsnow adapter broadcast failed for org %s: %v", orgID, err)
			continue
		}
		channel := adapterChannel(s.options.AdapterKey, NamespaceNewsnow, "org:"+orgID)
		if publishErr := s.redisOps.Publish(ctx, channel, encoded); publishErr != nil {
			// A publish failure only loses the cross-instance copies; the local
			// push below still runs, exactly like the NestJS adapter (which does
			// not await the publish before its local broadcast).
			log.Printf("realtimeevents: publish newsnow adapter broadcast failed for org %s: %v", orgID, publishErr)
		}
		sink.PublishOrg(NamespaceNewsnow, orgID, newsnowUpdateEvent, payloadJSON)
	}
}

// newSubscriptionClient creates the dedicated client used by the pub/sub
// connections and registers its cleanup.
func (s *Sources) newSubscriptionClient() *redis.Client {
	options := *s.options.RedisOptions
	client := redis.NewClient(&options)
	s.registerCloser(func() { _ = client.Close() })
	return client
}

// subscribePattern opens a pattern subscription and waits for the Redis
// confirmation so Start fails fast on an unreachable Redis.
func (s *Sources) subscribePattern(ctx context.Context, client *redis.Client, pattern string) (*redis.PubSub, error) {
	pubsub := client.PSubscribe(ctx, pattern)
	confirmCtx, cancel := context.WithTimeout(ctx, s.timeouts.subscribe)
	defer cancel()
	if _, err := pubsub.Receive(confirmCtx); err != nil {
		_ = pubsub.Close()
		return nil, fmt.Errorf("realtimeevents: subscribe %q: %w", pattern, err)
	}
	return pubsub, nil
}

// subscribeChannel opens a channel subscription and waits for confirmation.
func (s *Sources) subscribeChannel(ctx context.Context, client *redis.Client, channels ...string) (*redis.PubSub, error) {
	pubsub := client.Subscribe(ctx, channels...)
	confirmCtx, cancel := context.WithTimeout(ctx, s.timeouts.subscribe)
	defer cancel()
	if _, err := pubsub.Receive(confirmCtx); err != nil {
		_ = pubsub.Close()
		return nil, fmt.Errorf("realtimeevents: subscribe %v: %w", channels, err)
	}
	return pubsub, nil
}

// readPubSub forwards every Redis message to handle until the subscription is
// closed. go-redis reconnects and re-subscribes automatically.
func (s *Sources) readPubSub(ctx context.Context, pubsub *redis.PubSub, handle func(channel string, payload []byte)) {
	messages := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case message, ok := <-messages:
			if !ok {
				return
			}
			handle(message.Channel, []byte(message.Payload))
		}
	}
}

// formatISOMillis is new Date().toISOString(): UTC with exactly three
// fractional digits and the Z suffix.
func formatISOMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
