package situationsignals

// Realtime payload augmentation for the situation-monitor namespace.
//
// When the browser sockets live in the Go realtime transport, the NestJS
// gateway no longer augments the global signal events (its in-process socket
// enumeration is empty). This file ports
// augmentTelegramRealtimePayloadForUsers / augmentOrefRealtimePayloadForUsers:
// the monitor matcher is reused unchanged (explicit signals, lexical hits,
// semantic shortlist, LLM rerank, geo exclusion, ordering and result field
// order), and the augmented payload is the original JSON object with the extra
// key appended at the end, exactly like the `{...payload, monitorMatches}`
// spread. The original bytes are never re-encoded, so the browser sees the same
// key order the dispatcher produced.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"strings"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	// RealtimeTelegramUpdate and RealtimeOrefUpdate are the dispatcher event
	// types carried by the situation-monitor:signals:events:v1 bridge.
	RealtimeTelegramUpdate = "situation:telegram.update"
	RealtimeOrefUpdate     = "situation:oref.update"

	telegramUpdateMonitorMatchesKey = "monitorMatches"
	orefAlertMatchesKey             = "alertMonitorMatches"
	orefHistoryMatchesKey           = "historyMonitorMatches"
	orefAlertItemType               = "oref_alert"
	orefHistoryItemType             = "oref_history"
)

// RealtimeAugmenter augments situation-monitor payloads for the users
// connected to the current process. It is wired into internal/realtimeevents
// through their SituationAugmenter interface.
type RealtimeAugmenter struct {
	service *Service
}

// NewRealtimeAugmenter builds the augmenter on the shared MySQL/Redis/Mongo
// handles. The settings reader is not needed by the matcher, so the underlying
// Service is created without one.
func NewRealtimeAugmenter(db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database) *RealtimeAugmenter {
	return &RealtimeAugmenter{service: NewService(db, redisClient, mongoDatabase, nil)}
}

// AugmentRealtime returns one augmented payload per user. An empty map or an
// error makes the caller fall back to the original payload (the NestJS gateway
// fallback semantics: the monitorMatches keys are then absent, not empty).
func (a *RealtimeAugmenter) AugmentRealtime(ctx context.Context, eventType, orgID string, userIDs []string, payloadJSON json.RawMessage) (map[string]json.RawMessage, error) {
	if a == nil || a.service == nil {
		return nil, errors.New("situationsignals: realtime augmenter is not configured")
	}
	switch eventType {
	case RealtimeTelegramUpdate:
		return a.service.augmentTelegramRealtime(ctx, orgID, userIDs, payloadJSON)
	case RealtimeOrefUpdate:
		return a.service.augmentOrefRealtime(ctx, orgID, userIDs, payloadJSON)
	default:
		return nil, fmt.Errorf("situationsignals: unsupported realtime event type %q", eventType)
	}
}

// telegramRealtimePayload is the part of the telegram signal payload the
// matcher reads. items are the cached Telegram items written by the NestJS
// poller (verbatim JSON).
type telegramRealtimePayload struct {
	Items jsRawList `json:"items"`
}

// augmentTelegramRealtime mirrors augmentTelegramRealtimePayloadForUsers.
func (s *Service) augmentTelegramRealtime(ctx context.Context, orgID string, userIDs []string, payloadJSON json.RawMessage) (map[string]json.RawMessage, error) {
	normalized := normalizeRealtimeUserIDs(userIDs)
	out := make(map[string]json.RawMessage, len(normalized))
	if len(normalized) == 0 {
		return out, nil
	}
	var document telegramRealtimePayload
	if err := json.Unmarshal(payloadJSON, &document); err != nil {
		return nil, fmt.Errorf("situationsignals: decode telegram realtime payload: %w", err)
	}
	items := document.Items.Values()
	candidates := make([]monitorCandidate, 0, len(items))
	for _, item := range items {
		candidates = append(candidates, telegramCandidate(item))
	}
	matchesByUser, err := s.matchCandidatesForRealtimeUsers(ctx, orgID, normalized, candidates)
	if err != nil {
		return nil, err
	}
	for _, userID := range normalized {
		matches := matchesByUser[userID]
		if matches == nil {
			matches = []matchResult{}
		}
		encoded, err := json.Marshal(matches)
		if err != nil {
			return nil, err
		}
		augmented, err := appendJSONObjectField(payloadJSON, telegramUpdateMonitorMatchesKey, encoded)
		if err != nil {
			return nil, err
		}
		out[userID] = augmented
	}
	return out, nil
}

// orefRealtimePayload is the part of the oref signal payload the matcher reads.
type orefRealtimePayload struct {
	Alerts       jsRawList `json:"alerts"`
	HistoryEntry rawJSON   `json:"historyEntry"`
}

// orefRealtimeHistoryEntry is the historyEntry object of the oref payload.
type orefRealtimeHistoryEntry struct {
	Alerts jsRawList `json:"alerts"`
}

// augmentOrefRealtime mirrors augmentOrefRealtimePayloadForUsers. The
// alertMonitorMatches key is always appended; historyMonitorMatches is appended
// only when historyEntry is a non-null object (the NestJS conditional spread).
func (s *Service) augmentOrefRealtime(ctx context.Context, orgID string, userIDs []string, payloadJSON json.RawMessage) (map[string]json.RawMessage, error) {
	normalized := normalizeRealtimeUserIDs(userIDs)
	out := make(map[string]json.RawMessage, len(normalized))
	if len(normalized) == 0 {
		return out, nil
	}
	var document orefRealtimePayload
	if err := json.Unmarshal(payloadJSON, &document); err != nil {
		return nil, fmt.Errorf("situationsignals: decode oref realtime payload: %w", err)
	}
	alertCandidates := make([]monitorCandidate, 0)
	for _, alert := range document.Alerts.Values() {
		alertCandidates = append(alertCandidates, orefAlertCandidate(alert, orefAlertItemType))
	}
	alertMatchesByUser, err := s.matchCandidatesForRealtimeUsers(ctx, orgID, normalized, alertCandidates)
	if err != nil {
		return nil, err
	}

	var historyMatchesByUser map[string][]matchResult
	historyPresent := document.HistoryEntry.IsObject() && !document.HistoryEntry.isNull()
	if historyPresent {
		var entry orefRealtimeHistoryEntry
		if err := json.Unmarshal(document.HistoryEntry.raw, &entry); err != nil {
			return nil, fmt.Errorf("situationsignals: decode oref historyEntry: %w", err)
		}
		historyCandidates := make([]monitorCandidate, 0)
		for _, alert := range entry.Alerts.Values() {
			historyCandidates = append(historyCandidates, orefHistoryCandidate(alert, document.HistoryEntry))
		}
		historyMatchesByUser, err = s.matchCandidatesForRealtimeUsers(ctx, orgID, normalized, historyCandidates)
		if err != nil {
			return nil, err
		}
	}

	for _, userID := range normalized {
		alertMatches := alertMatchesByUser[userID]
		if alertMatches == nil {
			alertMatches = []matchResult{}
		}
		alertEncoded, err := json.Marshal(alertMatches)
		if err != nil {
			return nil, err
		}
		augmented, err := appendJSONObjectField(payloadJSON, orefAlertMatchesKey, alertEncoded)
		if err != nil {
			return nil, err
		}
		if historyPresent {
			historyMatches := historyMatchesByUser[userID]
			if historyMatches == nil {
				historyMatches = []matchResult{}
			}
			historyEncoded, err := json.Marshal(historyMatches)
			if err != nil {
				return nil, err
			}
			augmented, err = appendJSONObjectField(augmented, orefHistoryMatchesKey, historyEncoded)
			if err != nil {
				return nil, err
			}
		}
		out[userID] = augmented
	}
	return out, nil
}

// matchCandidatesForRealtimeUsers mirrors matchCandidatesForUsers: one monitor
// load per user, one embedding batch across all monitors (the NestJS single
// Prisma query is the only difference; the match core is shared with the HTTP
// paths), then the per-user match in normalized user order.
//
// O3: the caller resolves the online users once through the transport Sink, so
// the number of monitor queries is bounded by the local user count; the
// embedding/rerank calls are batched across all of them.
func (s *Service) matchCandidatesForRealtimeUsers(ctx context.Context, orgID string, userIDs []string, candidates []monitorCandidate) (map[string][]matchResult, error) {
	out := make(map[string][]matchResult, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	monitorsByUser := make(map[string][]monitorRecord, len(userIDs))
	allMonitors := make([]monitorRecord, 0)
	for _, userID := range userIDs {
		monitors, err := s.loadMonitors(ctx, orgID, userID)
		if err != nil {
			return nil, err
		}
		monitorsByUser[userID] = monitors
		allMonitors = append(allMonitors, monitors...)
	}
	if len(candidates) == 0 {
		for _, userID := range userIDs {
			out[userID] = []matchResult{}
		}
		return out, nil
	}
	embeddings := s.embedCandidateBatch(ctx, orgID, allMonitors, candidates)
	for _, userID := range userIDs {
		matches := s.matchCandidatesWithPreparedData(ctx, orgID, monitorsByUser[userID], candidates, embeddings)
		if matches == nil {
			matches = []matchResult{}
		}
		out[userID] = matches
	}
	return out, nil
}

// normalizeRealtimeUserIDs mirrors normalizeUserIds: trim, drop empty values and
// dedupe while preserving the first occurrence order.
func normalizeRealtimeUserIDs(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		userID := strings.TrimSpace(value)
		if userID == "" {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		out = append(out, userID)
	}
	return out
}

// appendJSONObjectField appends `"key":value` to a JSON object without touching
// the existing bytes, mirroring `{...payload, key: value}` (the original key
// order is preserved and the new key is last).
func appendJSONObjectField(payloadJSON json.RawMessage, key string, value json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(payloadJSON)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return nil, errors.New("situationsignals: realtime payload is not a JSON object")
	}
	if !json.Valid(trimmed) {
		return nil, errors.New("situationsignals: realtime payload is not valid JSON")
	}
	encodedKey, err := json.Marshal(key)
	if err != nil {
		return nil, err
	}
	body := trimmed[:len(trimmed)-1]
	out := make([]byte, 0, len(trimmed)+len(encodedKey)+len(value)+3)
	out = append(out, body...)
	if len(bytes.TrimSpace(body)) > 1 {
		out = append(out, ',')
	}
	out = append(out, encodedKey...)
	out = append(out, ':')
	out = append(out, value...)
	out = append(out, '}')
	return json.RawMessage(out), nil
}
