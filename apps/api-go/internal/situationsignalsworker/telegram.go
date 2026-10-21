package situationsignalsworker

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// telegramChannelsAsset is the verbatim copy of
// apps/api/src/modules/situation-monitor/signals/telegram-channels.json.
//
//go:embed telegram-channels.json
var telegramChannelsAsset embed.FS

// telegramChannelsFileName is the embedded catalog file name.
const telegramChannelsFileName = "telegram-channels.json"

// Telegram configured/error messages, copied from pollTelegramOnce and
// initTelegramClientIfNeeded.
const (
	telegramDisabledMessage       = "Telegram polling is disabled"
	telegramNotConfiguredMessage  = "Telegram credentials are not configured"
	telegramIncompleteMessage     = "Telegram credentials are incomplete"
	telegramNoChannelsMessage     = "No Telegram channels configured"
	telegramAuthDuplicatedMessage = "Telegram session invalidated (AUTH_KEY_DUPLICATED). Generate a new session."
	telegramPackageMissingMessage = "telegram package is not installed"
)

// telegramDefaultMaxMessages mirrors the `channel.maxMessages ?? 25` default.
const telegramDefaultMaxMessages = 25

// TelegramRuntimeConfig is SituationMonitorTelegramRuntimeConfig.
type TelegramRuntimeConfig struct {
	Enabled            bool
	APIID              string
	APIHash            string
	Session            string
	ChannelSet         string
	MaxFeedItems       int
	MaxTextChars       int
	ChannelTimeoutMS   int
	PollCycleTimeoutMS int
	StartupDelayMS     int
	RateLimitMS        int
	PollIntervalMS     int
}

// TelegramChannelConfig is one enabled entry of the embedded channel catalog.
type TelegramChannelConfig struct {
	Handle      string
	Label       string
	Topic       string
	Tier        *int
	Region      string
	MaxMessages *int
}

// telegramChannelEntry is the raw catalog entry. enabled is a pointer so the
// `enabled !== false` filter can tell "absent" from "false".
type telegramChannelEntry struct {
	Handle      string  `json:"handle"`
	Label       *string `json:"label"`
	Topic       *string `json:"topic"`
	Tier        *int    `json:"tier"`
	Enabled     *bool   `json:"enabled"`
	Region      *string `json:"region"`
	MaxMessages *int    `json:"maxMessages"`
}

// telegramChannelCatalog is the top-level catalog document.
type telegramChannelCatalog struct {
	Version   int                               `json:"version"`
	UpdatedAt string                            `json:"updatedAt"`
	Note      string                            `json:"note"`
	Channels  map[string][]telegramChannelEntry `json:"channels"`
}

// telegramChannelSets is parsed once from the embedded asset. The asset is part
// of the binary, so a parse error is a programming error and panics at startup.
var telegramChannelSets = mustLoadTelegramChannelSets()

// mustLoadTelegramChannelSets decodes the embedded catalog.
func mustLoadTelegramChannelSets() map[string][]telegramChannelEntry {
	raw, err := telegramChannelsAsset.ReadFile(telegramChannelsFileName)
	if err != nil {
		panic(fmt.Sprintf("situationsignalsworker: read embedded %s: %v", telegramChannelsFileName, err))
	}
	var catalog telegramChannelCatalog
	if err := json.Unmarshal(raw, &catalog); err != nil {
		panic(fmt.Sprintf("situationsignalsworker: parse embedded %s: %v", telegramChannelsFileName, err))
	}
	return catalog.Channels
}

// loadTelegramChannels mirrors loadTelegramChannels: take the configured
// channel set, normalize each handle (one leading @ removed and trimmed), drop
// empty handles and entries explicitly disabled.
func loadTelegramChannels(setName string) []TelegramChannelConfig {
	entries := telegramChannelSets[setName]
	channels := make([]TelegramChannelConfig, 0, len(entries))
	for _, entry := range entries {
		handle := normalizeTelegramHandle(entry.Handle)
		if handle == "" {
			continue
		}
		if entry.Enabled != nil && !*entry.Enabled {
			continue
		}
		channel := TelegramChannelConfig{
			Handle:      handle,
			Tier:        entry.Tier,
			MaxMessages: entry.MaxMessages,
		}
		if entry.Label != nil {
			channel.Label = *entry.Label
		}
		if entry.Topic != nil {
			channel.Topic = *entry.Topic
		}
		if entry.Region != nil {
			channel.Region = *entry.Region
		}
		channels = append(channels, channel)
	}
	return channels
}

// telegramChannelMessageLimit mirrors
// Math.max(1, Math.min(50, Math.floor(channel.maxMessages ?? 25))).
func telegramChannelMessageLimit(channel TelegramChannelConfig) int {
	limit := telegramDefaultMaxMessages
	if channel.MaxMessages != nil {
		limit = *channel.MaxMessages
	}
	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 1
	}
	return limit
}

// telegramRuntimeConfig mirrors getTelegramRuntimeConfig, including the
// environment fallback used when the settings row cannot be read.
func (s *Service) telegramRuntimeConfig(ctx context.Context) TelegramRuntimeConfig {
	effective, err := s.settings.EffectiveSettings(ctx)
	if err != nil {
		s.logf("situationsignalsworker: failed to read telegram runtime config from system settings; using env fallback: %v", err)
		return telegramRuntimeConfigFromEnv(s.env)
	}
	channelSet := strings.TrimSpace(effective.TelegramChannelSet)
	if channelSet == "" {
		channelSet = defaultTelegramChannelSet
	}
	return TelegramRuntimeConfig{
		Enabled:            effective.TelegramEnabled,
		APIID:              effective.TelegramAPIID,
		APIHash:            effective.TelegramAPIHash,
		Session:            effective.TelegramSession,
		ChannelSet:         channelSet,
		MaxFeedItems:       effective.TelegramMaxFeedItems,
		MaxTextChars:       effective.TelegramMaxTextChars,
		ChannelTimeoutMS:   effective.TelegramChannelTimeoutMS,
		PollCycleTimeoutMS: effective.TelegramPollCycleTimeoutMS,
		StartupDelayMS:     effective.TelegramStartupDelayMS,
		RateLimitMS:        effective.TelegramRateLimitMS,
		PollIntervalMS:     effective.TelegramPollIntervalMS,
	}
}

// telegramRuntimeConfigFromEnv is the getTelegramRuntimeConfig catch branch.
// NestJS deliberately leaves the session undefined on this path because the
// session is stored encrypted in MySQL only.
func telegramRuntimeConfigFromEnv(env Env) TelegramRuntimeConfig {
	return TelegramRuntimeConfig{
		Enabled:            env.TelegramEnabled,
		APIID:              env.TelegramAPIID,
		APIHash:            env.TelegramAPIHash,
		Session:            "",
		ChannelSet:         env.TelegramChannelSet,
		MaxFeedItems:       env.TelegramMaxFeedItems,
		MaxTextChars:       env.TelegramMaxTextChars,
		ChannelTimeoutMS:   env.TelegramChannelTimeoutMS,
		PollCycleTimeoutMS: env.TelegramPollCycleTimeoutMS,
		StartupDelayMS:     env.TelegramStartupDelayMS,
		RateLimitMS:        env.TelegramRateLimitMS,
		PollIntervalMS:     env.TelegramPollIntervalMS,
	}
}

// telegramCredentialsFingerprint mirrors computeTelegramCredentialsFingerprint.
func telegramCredentialsFingerprint(apiID int, apiHash, session string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%d|%s|%s", apiID, apiHash, session)))
	return hex.EncodeToString(digest[:])
}

// buildTelegramClientOptions mirrors initTelegramClientIfNeeded's validation
// and construction. The incomplete-credentials error text is the NestJS one;
// a malformed session string becomes the "telegram init failed" error.
func buildTelegramClientOptions(runtime TelegramRuntimeConfig) (telegramclient.Options, string, error) {
	if strings.TrimSpace(runtime.APIID) == "" || strings.TrimSpace(runtime.APIHash) == "" || strings.TrimSpace(runtime.Session) == "" {
		return telegramclient.Options{}, "", errors.New(telegramIncompleteMessage)
	}
	parsedAPIID := parseJSNumber(runtime.APIID)
	if math.IsNaN(parsedAPIID) || math.IsInf(parsedAPIID, 0) {
		return telegramclient.Options{}, "", errors.New(telegramIncompleteMessage)
	}
	apiID := int(math.Trunc(parsedAPIID))
	session, err := telegramclient.DecodeStringSession(runtime.Session)
	if err != nil {
		return telegramclient.Options{}, "", fmt.Errorf("telegram init failed: %w", err)
	}
	options := telegramclient.Options{
		APIID:   apiID,
		APIHash: runtime.APIHash,
		Session: session,
	}
	return options, telegramCredentialsFingerprint(apiID, runtime.APIHash, runtime.Session), nil
}

// pollTelegram mirrors pollTelegramOnce with the B1 lease fix, the B2 poll
// handover and the B4 error retention fix.
//
// The outcome tells the caller whether this process actually ran the cycle, which
// is what the handover request path needs: only the process that polled may record
// a completion for the waiting caller.
func (s *Service) pollTelegram(ctx context.Context, mode telegramPollMode) (telegramCycleOutcome, error) {
	runtime := s.telegramRuntimeConfig(ctx)

	state, err := s.loadTelegramState(ctx)
	if err != nil {
		return telegramCycleRefused, err
	}
	state.PermanentlyDisabled = s.telegramPermanentlyDisabled
	s.telegramState = state

	// syncTelegramStateWithRuntime clears a cached feed that belongs to another
	// channel set and persists the emptied state.
	s.syncTelegramStateWithRuntime(ctx, runtime.ChannelSet)

	if !runtime.Enabled {
		s.telegramState.LastError = telegramDisabledMessage
		return telegramCycleRefused, nil
	}
	if strings.TrimSpace(runtime.APIID) == "" || strings.TrimSpace(runtime.APIHash) == "" || strings.TrimSpace(runtime.Session) == "" {
		s.telegramState.LastError = telegramNotConfiguredMessage
		return telegramCycleRefused, nil
	}
	if s.telegramPermanentlyDisabled {
		return telegramCycleRefused, nil
	}
	if runtime.StartupDelayMS > 0 && s.telegramState.LastPollAt == 0 {
		// The delay is measured from process start, not from the previous poll.
		if s.now().Sub(s.serviceStartedAt) < time.Duration(runtime.StartupDelayMS)*time.Millisecond {
			return telegramCycleRefused, nil
		}
	}

	options, fingerprint, err := buildTelegramClientOptions(runtime)
	if err != nil {
		s.telegramState.LastError = err.Error()
		s.logf("situationsignalsworker: telegram init failed")
		return telegramCycleRefused, nil
	}

	// B1: only the process that wins the Redis lease creates or holds the
	// MTProto connection. A process without the lease performs no Telegram work.
	owned, leaseErr := s.telegram.WithLease(ctx, options, fingerprint, func(callCtx context.Context, client telegramclient.PollClient) error {
		s.pollTelegramWithClient(callCtx, runtime, client)
		return nil
	})
	if leaseErr != nil {
		s.telegramState.LastError = fmt.Sprintf("telegram poll failed: %v", leaseErr)
		s.logf("situationsignalsworker: telegram poll failed: %v", leaseErr)
		return telegramCycleRefused, nil
	}
	if !owned {
		if mode == telegramPollServe {
			// A request received on the handover channel is never forwarded again:
			// every instance subscribes to that channel, so re-publishing would fan
			// out without end. Only the lease owner (or a process that just acquired
			// the lease) serves the request, and only it records the completion.
			s.logf("situationsignalsworker: telegram poll request not served here because this instance does not own the lease; the owner serves it")
			return telegramCycleSkipped, nil
		}
		// B2: the lease owner keeps the MTProto connection, so this cycle must run
		// there. Publishing the request instead of skipping it keeps the configured
		// poll frequency independent of which instance the queue picks.
		return s.handoverTelegramPoll(ctx, runtime, options, fingerprint, mode)
	}
	s.completeTelegramOwnedCycle(ctx)
	return telegramCyclePolled, nil
}

// completeTelegramOwnedCycle is the post-cycle step of the process that owns the
// lease: a session invalidated by AUTH_KEY_DUPLICATED must never be used again.
// The disconnect runs outside WithLease so the manager's call serialization is
// not re-entered.
func (s *Service) completeTelegramOwnedCycle(ctx context.Context) {
	if !s.telegramState.PermanentlyDisabled {
		return
	}
	s.telegramPermanentlyDisabled = true
	s.disconnectTelegram(ctx)
}

// pollTelegramWithClient runs one poll cycle over the embedded channel catalog.
func (s *Service) pollTelegramWithClient(ctx context.Context, runtime TelegramRuntimeConfig, client telegramclient.PollClient) {
	channels := loadTelegramChannels(runtime.ChannelSet)
	// loadTelegramChannels records the channel set on the state exactly like the
	// NestJS helper, so the persisted document carries the set the feed belongs
	// to and the next sync does not mistake it for a set change.
	channelSet := runtime.ChannelSet
	s.telegramState.ChannelSet = &channelSet
	if len(channels) == 0 {
		s.telegramState.LastError = telegramNoChannelsMessage
		return
	}

	pollStart := s.now()
	newItems := make([]TelegramItem, 0, 32)
	channelsPolled := 0
	channelsFailed := 0
	mediaSkipped := 0
	floodWait := false
	cycleTimedOut := false

	for _, channel := range channels {
		if s.now().Sub(pollStart).Milliseconds() > int64(runtime.PollCycleTimeoutMS) {
			cycleTimedOut = true
			s.logf("situationsignalsworker: telegram poll cycle timeout reached after %d/%d channels", channelsPolled, len(channels))
			break
		}
		handle := normalizeTelegramHandle(channel.Handle)
		if handle == "" {
			continue
		}

		minID := int(s.telegramState.CursorByHandle[handle])
		limit := telegramChannelMessageLimit(channel)

		peer, err := withChannelTimeout(ctx, runtime.ChannelTimeoutMS, fmt.Sprintf("getEntity(%s)", handle), func(callCtx context.Context) (telegramclient.Peer, error) {
			return client.ResolveChannel(callCtx, handle)
		})
		if err != nil {
			s.recordTelegramChannelError(ctx, handle, err)
			channelsFailed++
			if s.telegramState.PermanentlyDisabled {
				break
			}
			if telegramclient.IsFloodWait(err) {
				floodWait = true
				break
			}
			continue
		}

		messages, err := withChannelTimeout(ctx, runtime.ChannelTimeoutMS, fmt.Sprintf("getMessages(%s)", handle), func(callCtx context.Context) ([]telegramclient.Message, error) {
			return client.FetchHistory(callCtx, peer, limit, minID)
		})
		if err != nil {
			s.recordTelegramChannelError(ctx, handle, err)
			channelsFailed++
			if s.telegramState.PermanentlyDisabled {
				break
			}
			if telegramclient.IsFloodWait(err) {
				floodWait = true
				break
			}
			continue
		}

		for _, message := range messages {
			if message.ID <= 0 {
				continue
			}
			if strings.TrimSpace(message.Text) == "" {
				mediaSkipped++
				continue
			}
			newItems = append(newItems, normalizeTelegramMessage(message, channel, handle, runtime.MaxTextChars))
			if cursor := int64(message.ID); cursor > s.telegramState.CursorByHandle[handle] {
				s.telegramState.CursorByHandle[handle] = cursor
			}
		}

		channelsPolled++
		if err := sleepContext(ctx, time.Duration(runtime.RateLimitMS)*time.Millisecond); err != nil {
			cycleTimedOut = true
			break
		}
	}

	if len(newItems) > 0 {
		s.telegramState.Items = mergeTelegramItems(newItems, s.telegramState.Items, runtime.MaxFeedItems)
	}
	s.telegramState.LastPollAt = s.now().UnixMilli()
	// B4: NestJS cleared lastError unconditionally. Go keeps the last channel
	// error unless every channel was polled successfully in a complete cycle.
	if channelsFailed == 0 && !floodWait && !cycleTimedOut {
		s.telegramState.LastError = ""
	}
	s.persistTelegramState(ctx, s.telegramState)

	if len(newItems) > 0 {
		payload := telegramUpdatePayload{
			Count:     len(s.telegramState.Items),
			UpdatedAt: nestISOTimeMillis(s.telegramState.LastPollAt),
			Items:     sliceTelegramItems(newItems, 30),
		}
		s.publishEvent(ctx, RealtimeEventTelegramUpdate, payload)
	}

	s.logf("situationsignalsworker: telegram poll finished channelsPolled=%d channelsTotal=%d newItems=%d totalItems=%d channelsFailed=%d mediaSkipped=%d",
		channelsPolled, len(channels), len(newItems), len(s.telegramState.Items), channelsFailed, mediaSkipped)
}

// recordTelegramChannelError mirrors the catch block of the channel loop:
// store the NestJS-shaped error, set permanentlyDisabled for
// AUTH_KEY_DUPLICATED and log everything else.
func (s *Service) recordTelegramChannelError(ctx context.Context, handle string, err error) {
	description := telegramclient.ErrorDescription(err)
	message := err.Error()
	if description != "" && description != message {
		message = fmt.Sprintf("%s: %s", description, message)
	}
	s.telegramState.LastError = fmt.Sprintf("poll %s failed: %s", handle, message)

	if telegramclient.IsAuthKeyDuplicated(err) {
		s.telegramState.PermanentlyDisabled = true
		s.telegramState.LastError = telegramAuthDuplicatedMessage
		s.logf("situationsignalsworker: telegram session invalidated (AUTH_KEY_DUPLICATED); polling disabled until the configuration is cleared")
		return
	}
	if telegramclient.IsFloodWait(err) {
		s.logf("situationsignalsworker: telegram FLOOD_WAIT detected, stopping cycle early (handle=%s wait=%ds)", handle, telegramclient.FloodWaitSeconds(err))
		return
	}
	s.logf("situationsignalsworker: telegram channel poll failed handle=%s err=%v", handle, err)
}

// syncTelegramStateWithRuntime mirrors syncTelegramStateWithRuntime: a cached
// feed from another channel set is discarded and the empty state persisted.
func (s *Service) syncTelegramStateWithRuntime(ctx context.Context, runtimeChannelSet string) {
	if s.telegramState.ChannelSet != nil && *s.telegramState.ChannelSet == runtimeChannelSet {
		return
	}
	hasCachedState := len(s.telegramState.Items) > 0 || s.telegramState.LastPollAt > 0 || len(s.telegramState.CursorByHandle) > 0
	if !hasCachedState && s.telegramState.ChannelSet == nil {
		return
	}
	s.logf("situationsignalsworker: telegram channel set changed; clearing cached feed state")
	channelSet := runtimeChannelSet
	s.telegramState.ChannelSet = &channelSet
	s.telegramState.CursorByHandle = map[string]int64{}
	s.telegramState.Items = []TelegramItem{}
	s.telegramState.LastPollAt = 0
	s.telegramState.LastError = ""
	s.persistTelegramState(ctx, s.telegramState)
}

// clearTelegramState mirrors clearTelegramState: disconnect the MTProto client,
// reset the local state and delete the shared cache document (A2 clear
// broadcast).
func (s *Service) clearTelegramState(ctx context.Context, clearItems bool) {
	s.disconnectTelegram(ctx)
	s.telegramPermanentlyDisabled = false
	s.telegramState.ChannelSet = nil
	s.telegramState.CursorByHandle = map[string]int64{}
	if clearItems {
		s.telegramState.Items = []TelegramItem{}
		s.telegramState.LastPollAt = 0
	}
	s.telegramState.LastError = ""
	s.telegramState.PermanentlyDisabled = false
	s.deleteTelegramState(ctx)
}

// disconnectTelegram releases the lease and drops the long-lived connection.
// telegramclient.Manager.Disconnect keeps the manager reusable, so a later
// configuration change can poll again.
func (s *Service) disconnectTelegram(ctx context.Context) {
	if s.telegram == nil {
		return
	}
	if err := s.telegram.Disconnect(ctx); err != nil {
		s.logf("situationsignalsworker: telegram disconnect failed: %v", err)
	}
}

// withChannelTimeout mirrors withTimeout: one per-channel RPC deadline with the
// NestJS error text `TIMEOUT <ms>ms: <label>`.
func withChannelTimeout[T any](ctx context.Context, timeoutMS int, label string, call func(context.Context) (T, error)) (T, error) {
	if timeoutMS <= 0 {
		return call(ctx)
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	value, err := call(callCtx)
	if err != nil && errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		var zero T
		return zero, fmt.Errorf("TIMEOUT %dms: %s", timeoutMS, label)
	}
	return value, err
}
