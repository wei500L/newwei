package situationsignals

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"

	"github.com/redis/go-redis/v9"
)

// telegramCachedState is the normalized cached Telegram state. It mirrors the
// in-process TelegramState of the NestJS signals service, but it is rebuilt from
// Redis on every request: this process keeps no feed state of its own.
type telegramCachedState struct {
	ChannelSet *string
	Cursors    map[string]float64
	Items      []rawJSON
	LastPollAt float64
	LastError  *string
}

// emptyTelegramState is the state used when Redis holds no usable record.
func emptyTelegramState() telegramCachedState {
	return telegramCachedState{Cursors: map[string]float64{}, Items: []rawJSON{}}
}

// cachedTelegramStateDocument is the document the NestJS poller persists.
type cachedTelegramStateDocument struct {
	ChannelSet     rawJSON     `json:"channelSet"`
	CursorByHandle rawJSON     `json:"cursorByHandle"`
	Items          jsRawList   `json:"items"`
	LastPollAt     jsNumberish `json:"lastPollAt"`
	LastError      rawJSON     `json:"lastError"`
}

// loadCachedTelegramState mirrors restoreCachedTelegramState.
//
// NestJS keeps the feed in memory and only consults Redis when the in-process
// item list is empty; this process always reads Redis. That is the documented
// one-poll-cycle difference between the two implementations.
//
// A Redis failure yields the empty state rather than an error: NestJS wraps the
// whole restore in a best-effort try/catch.
func (s *Service) loadCachedTelegramState(ctx context.Context) telegramCachedState {
	state := emptyTelegramState()
	if s == nil || s.cache.get == nil {
		return state
	}
	raw, err := s.cache.get(ctx, telegramStateKey)
	if errors.Is(err, redis.Nil) {
		return state
	}
	if err != nil {
		log.Printf("situationsignals: telegram state cache read failed: %v", err)
		return state
	}

	var document cachedTelegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return state
	}
	// `!cached || !Array.isArray(cached.items)` leaves the state untouched.
	if !document.Items.IsArray() {
		return state
	}

	state.Items = document.Items.Values()
	if channelSet, ok := document.ChannelSet.asString(); ok {
		trimmed := strings.TrimSpace(channelSet)
		if trimmed != "" {
			state.ChannelSet = &trimmed
		}
	}
	if fields, ok := decodeObjectFields(document.CursorByHandle.raw); ok {
		for _, handle := range fields.order {
			normalizedHandle := strings.TrimSpace(handle)
			if normalizedHandle == "" {
				continue
			}
			cursor, ok := jsNumber(fields.values[handle], true)
			if !ok || cursor <= 0 {
				continue
			}
			state.Cursors[normalizedHandle] = cursor
		}
	}
	if polled, ok := document.LastPollAt.Number(); ok {
		state.LastPollAt = polled
	}
	if message, ok := document.LastError.asString(); ok {
		state.LastError = &message
	}
	return state
}

// syncTelegramStateWithRuntime mirrors syncTelegramStateWithRuntime.
//
// The channel set is a cache key version: when the configured set no longer
// matches the cached one, the cached feed belongs to a different channel set and
// must be discarded and re-persisted, otherwise the caller would read items from
// channels that are no longer configured.
//
// NestJS also looks at an in-process `channels` list, which this process does not
// have; `hasCachedState` here is items, lastPollAt and cursors.
func (s *Service) syncTelegramStateWithRuntime(ctx context.Context, state telegramCachedState, runtimeChannelSet string) telegramCachedState {
	if state.ChannelSet != nil && *state.ChannelSet == runtimeChannelSet {
		return state
	}
	hasCachedState := len(state.Items) > 0 || state.LastPollAt > 0 || len(state.Cursors) > 0
	if !hasCachedState && state.ChannelSet == nil {
		return state
	}
	cleared := emptyTelegramState()
	channelSet := runtimeChannelSet
	cleared.ChannelSet = &channelSet
	s.persistTelegramState(ctx, cleared)
	return cleared
}

// persistTelegramState writes the cached state back with the same key, shape and
// 24 hour TTL the NestJS poller uses.
func (s *Service) persistTelegramState(ctx context.Context, state telegramCachedState) {
	if s == nil || s.cache.set == nil {
		return
	}
	payload := telegramStatePayload{
		ChannelSet:     state.ChannelSet,
		CursorByHandle: state.Cursors,
		Items:          state.Items,
		LastPollAt:     state.LastPollAt,
		LastError:      state.LastError,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if err := s.cache.set(ctx, telegramStateKey, encoded, telegramStateTTL); err != nil {
		// The NestJS persist is best-effort: a write failure must not fail the
		// read the caller asked for.
		log.Printf("situationsignals: telegram state persist failed: %v", err)
	}
}

// telegramStatePayload is the persisted cached-state document.
type telegramStatePayload struct {
	ChannelSet     *string            `json:"channelSet"`
	CursorByHandle map[string]float64 `json:"cursorByHandle"`
	Items          []rawJSON          `json:"items"`
	LastPollAt     float64            `json:"lastPollAt"`
	LastError      *string            `json:"lastError"`
}

// filterTelegramItems mirrors the topic/channel filter followed by
// `slice(0, limit)`. A blank filter never matches anything away, exactly like
// the falsy check in JavaScript.
func filterTelegramItems(items []rawJSON, topic, channel string, limit int) []rawJSON {
	filtered := make([]rawJSON, 0, len(items))
	for _, item := range items {
		if topic != "" || channel != "" {
			fields := decodeTelegramItem(item)
			if topic != "" && strings.ToLower(stringOrEmpty(fields.Topic)) != topic {
				continue
			}
			if channel != "" && strings.ToLower(stringOrEmpty(fields.Channel)) != channel {
				continue
			}
		}
		filtered = append(filtered, item)
		if len(filtered) >= limit {
			break
		}
	}
	return filtered
}

// telegramFeedResponse is the GET /telegram-feed body.
type telegramFeedResponse struct {
	Source         string        `json:"source"`
	Scope          string        `json:"scope"`
	EarlySignal    bool          `json:"earlySignal"`
	Configured     bool          `json:"configured"`
	Enabled        bool          `json:"enabled"`
	ChannelSet     string        `json:"channelSet"`
	Count          int           `json:"count"`
	UpdatedAt      *string       `json:"updatedAt"`
	Items          []rawJSON     `json:"items"`
	Error          string        `json:"error,omitempty"`
	MonitorMatches []matchResult `json:"monitorMatches"`
}

// getTelegramFeed mirrors getTelegramFeed plus augmentTelegramFeed.
func (s *Service) getTelegramFeed(ctx context.Context, orgID, userID string, limit int, topic, channel string) (telegramFeedResponse, error) {
	state := s.loadCachedTelegramState(ctx)
	runtime, err := s.settings.telegramRuntimeConfig(ctx)
	if err != nil {
		return telegramFeedResponse{}, err
	}
	state = s.syncTelegramStateWithRuntime(ctx, state, runtime.ChannelSet)

	normalizedTopic := strings.ToLower(strings.TrimSpace(topic))
	normalizedChannel := strings.ToLower(strings.TrimSpace(channel))

	filtered := filterTelegramItems(state.Items, normalizedTopic, normalizedChannel, limit)

	channelSet := runtime.ChannelSet
	if state.ChannelSet != nil {
		channelSet = *state.ChannelSet
	}
	var updatedAt *string
	if state.LastPollAt != 0 {
		value := nestISOTime(state.LastPollAt)
		updatedAt = &value
	}

	response := telegramFeedResponse{
		Source:      "telegram",
		Scope:       "global",
		EarlySignal: true,
		Configured:  runtime.configured(),
		Enabled:     runtime.Enabled,
		ChannelSet:  channelSet,
		Count:       len(filtered),
		UpdatedAt:   updatedAt,
		Items:       filtered,
	}
	if state.LastError != nil {
		response.Error = *state.LastError
	}

	candidates := make([]monitorCandidate, 0, len(filtered))
	for _, item := range filtered {
		candidates = append(candidates, telegramCandidate(item))
	}
	matches, err := s.matchCandidates(ctx, orgID, userID, candidates)
	if err != nil {
		return telegramFeedResponse{}, err
	}
	response.MonitorMatches = matches
	return response, nil
}
