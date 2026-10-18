package dataruntimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
)

// This file implements GET /api/admin/archive-preparation/status.
//
// The route reads the derived archive preparation status index from Redis (an
// index zset plus one JSON record per member). It is NOT BullMQ job counts: the
// records are written by the archive preparation worker, the `delayed` counter is
// fixed at 0 by the current protocol and is deliberately not "corrected" by
// querying BullMQ's delayed set.

// archiveStatusCounts is the counts object of the response.
type archiveStatusCounts struct {
	Waiting   int `json:"waiting"`
	Active    int `json:"active"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Delayed   int `json:"delayed"`
}

// archivePublicStatusRecord is one entry of recentStatuses. It deliberately
// carries no orgId, no Redis key and no trace id.
//
// ErrorMessage is raw JSON so the original `undefined`/`null` -> null and
// empty-string-preserved semantics survive, and so a non-string stored value is
// passed through rather than dropped.
type archivePublicStatusRecord struct {
	Scope        ArchivePreparationScope `json:"scope"`
	ScopeValue   string                  `json:"scopeValue"`
	State        ArchivePreparationState `json:"state"`
	UpdatedAt    string                  `json:"updatedAt"`
	ErrorMessage json.RawMessage         `json:"errorMessage"`
}

// archiveOperationalStatus is the response body.
type archiveOperationalStatus struct {
	UpdatedAt      string                      `json:"updatedAt"`
	Pending        int                         `json:"pending"`
	Counts         archiveStatusCounts         `json:"counts"`
	RecentStatuses []archivePublicStatusRecord `json:"recentStatuses"`
}

// encodeJSON renders the operational status.
func (s archiveOperationalStatus) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// storedArchiveStatusRecord is the tolerant read view of one Redis record. Every
// member stays raw so a record written with an unexpected member type never aborts
// the whole read: NestJS spreads the decoded value and reads members by name, so a
// wrong type simply fails the orgId comparison or the state switch.
type storedArchiveStatusRecord struct {
	OrgIDRaw        json.RawMessage
	ScopeRaw        json.RawMessage
	ScopeValueRaw   json.RawMessage
	StateRaw        json.RawMessage
	UpdatedAtRaw    json.RawMessage
	ErrorMessageRaw json.RawMessage
	// orgID is the resolved organisation: the record member when it is a string,
	// otherwise the legacy key segment.
	orgID string
	// state is the resolved state used for counting.
	state ArchivePreparationState
}

// recordMembers is the decoded object shape.
type recordMembers struct {
	OrgID        json.RawMessage `json:"orgId"`
	Scope        json.RawMessage `json:"scope"`
	ScopeValue   json.RawMessage `json:"scopeValue"`
	State        json.RawMessage `json:"state"`
	UpdatedAt    json.RawMessage `json:"updatedAt"`
	ErrorMessage json.RawMessage `json:"errorMessage"`
}

// getArchiveOperationalStatus mirrors getOperationalStatus.
//
// DS4: the counters and the recent list are derived from ONE org-scoped snapshot.
// NestJS previously ran `getRecentStatuses` and `getScopedCounts` as two
// independent ZCARD/ZRANGE/MGET passes, so a worker finishing in between could
// make a single response contradict itself. This guarantees only that one response
// is self-consistent with the snapshot it read: ZRANGE followed by MGET is still
// not an atomic transaction over the whole index, and no Lua script, global lock
// or worker lock is introduced. The reader never writes, trims, renews or deletes
// index entries — the 200-entry trim is the writer's policy.
func (s *Service) getArchiveOperationalStatus(ctx context.Context, orgID string) (*archiveOperationalStatus, error) {
	records, err := s.getScopedStatusRecords(ctx, orgID)
	if err != nil {
		return nil, err
	}
	counts := countStatusStates(records)
	pending := counts.Waiting + counts.Active + counts.Delayed
	recent := make([]archivePublicStatusRecord, 0, archiveStatusRecentLimit)
	for _, record := range records {
		if len(recent) >= archiveStatusRecentLimit {
			break
		}
		recent = append(recent, toPublicStatusRecord(record))
	}
	return &archiveOperationalStatus{
		UpdatedAt:      nestTimestamp(nowMillis()),
		Pending:        pending,
		Counts:         counts,
		RecentStatuses: recent,
	}, nil
}

// countStatusStates maps the snapshot states onto the counters. `IDLE` and any
// other unknown value increase nothing.
func countStatusStates(records []storedArchiveStatusRecord) archiveStatusCounts {
	counts := archiveStatusCounts{}
	for _, record := range records {
		switch record.state {
		case ArchiveStateQueued:
			counts.Waiting++
		case ArchiveStateProcessing, ArchiveStatePartial:
			counts.Active++
		case ArchiveStateReady:
			counts.Completed++
		case ArchiveStateFailed:
			counts.Failed++
		default:
		}
	}
	return counts
}

// toPublicStatusRecord is the public mapping. DS3: the stored failure text comes
// from a worker's raw error.message, which can carry Bearer/Basic credentials or
// password=/token=/api_key=/secret= fragments, so it is redacted with the shared
// adminlogs.RedactSensitiveFields implementation (never a second regex set, and
// never a change to the Redis record itself).
func toPublicStatusRecord(record storedArchiveStatusRecord) archivePublicStatusRecord {
	return archivePublicStatusRecord{
		Scope:        record.publicScope(),
		ScopeValue:   normalizeStringRaw(record.ScopeValueRaw),
		State:        record.state,
		UpdatedAt:    normalizeStringRaw(record.UpdatedAtRaw),
		ErrorMessage: redactPublicErrorMessage(record.ErrorMessageRaw),
	}
}

// publicScope normalizes the stored scope member to the closed enum.
func (r storedArchiveStatusRecord) publicScope() ArchivePreparationScope {
	switch normalizeStringRaw(r.ScopeRaw) {
	case string(ArchiveScopeDigest):
		return ArchiveScopeDigest
	case string(ArchiveScopeCalendar):
		return ArchiveScopeCalendar
	default:
		return ""
	}
}

// redactPublicErrorMessage applies the shared redaction to a string member.
//
// A missing member and JSON null become the JSON literal null; an empty string
// stays ""; a non-string member is passed through unchanged, which is what the
// NestJS `record.errorMessage ?? null` mapping plus a redaction helper that
// returns non-strings untouched does.
func redactPublicErrorMessage(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return jsonNullValue
	}
	if trimmed[0] != '"' {
		return raw
	}
	text, ok := decodeJSONString(trimmed)
	if !ok {
		return raw
	}
	redacted, err := json.Marshal(adminlogs.RedactSensitiveFields(text))
	if err != nil {
		return jsonNullValue
	}
	return redacted
}

// getScopedStatusRecords reads the org-scoped snapshot:
//  1. ZCARD the index;
//  2. when non-empty, ZRANGE 0..total-1 (ascending score order, Redis
//     lexicographic order for equal scores);
//  3. MGET the members, preserving that order and skipping expired members;
//  4. recover a missing orgId from the fifth segment of the legacy key;
//  5. keep only the caller's organisation;
//  6. reverse, so the newest writes come first.
//
// A Redis failure is propagated: it is never turned into a zeroed "healthy"
// status.
func (s *Service) getScopedStatusRecords(ctx context.Context, orgID string) ([]storedArchiveStatusRecord, error) {
	total, err := s.zcard(ctx, archiveStatusIndexKey)
	if err != nil {
		return nil, err
	}
	if total <= 0 {
		return nil, nil
	}
	keys, err := s.zrange(ctx, archiveStatusIndexKey, 0, total-1)
	if err != nil {
		return nil, err
	}
	values, err := s.mget(ctx, keys)
	if err != nil {
		return nil, err
	}
	return selectScopedStatusRecords(keys, values, orgID), nil
}

// selectScopedStatusRecords is the pure part of the snapshot read: it keeps the
// index order, skips expired members, recovers a missing orgId from the legacy key
// and filters on the caller's organisation, then reverses the result so the newest
// writes come first. Keeping it separate from the Redis calls is what makes the
// org-isolation and ordering rules directly unit-testable.
func selectScopedStatusRecords(keys []string, values []json.RawMessage, orgID string) []storedArchiveStatusRecord {
	records := make([]storedArchiveStatusRecord, 0, len(keys))
	for index, key := range keys {
		var raw json.RawMessage
		if index < len(values) {
			raw = values[index]
		}
		record, ok := normalizeStatusRecord(key, raw)
		if !ok {
			continue
		}
		if record.orgID != orgID {
			continue
		}
		records = append(records, record)
	}
	// Reverse in place: the zset is ascending by write time and the response
	// reports newest first.
	for left, right := 0, len(records)-1; left < right; left, right = left+1, right-1 {
		records[left], records[right] = records[right], records[left]
	}
	return records
}

// normalizeStatusRecord decodes one member and applies the orgId fallback. It
// returns ok=false for an expired member (missing value) and for a record whose
// orgId can be neither read as a string nor recovered from the key.
func normalizeStatusRecord(statusKey string, raw json.RawMessage) (storedArchiveStatusRecord, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		// An expired index member is skipped, never counted.
		return storedArchiveStatusRecord{}, false
	}
	members := recordMembers{}
	if bytes.HasPrefix(trimmed, []byte("{")) {
		if err := json.Unmarshal(trimmed, &members); err != nil {
			return storedArchiveStatusRecord{}, false
		}
	}

	record := storedArchiveStatusRecord{
		OrgIDRaw:        members.OrgID,
		ScopeRaw:        members.Scope,
		ScopeValueRaw:   members.ScopeValue,
		StateRaw:        members.State,
		UpdatedAtRaw:    members.UpdatedAt,
		ErrorMessageRaw: members.ErrorMessage,
	}
	record.state = ArchivePreparationState(normalizeStringRaw(members.State))

	orgTrimmed := bytes.TrimSpace(members.OrgID)
	if len(orgTrimmed) > 0 && !bytes.Equal(orgTrimmed, []byte("null")) {
		// A present member wins over the key segment, exactly like `??`. A
		// present non-string member normalizes to "" and can never equal the
		// caller's string org id, which is the same comparison outcome NestJS
		// gets.
		record.orgID = normalizeStringRaw(members.OrgID)
	} else {
		record.orgID = parseOrgIDFromStatusKey(statusKey)
	}
	if record.orgID == "" {
		return storedArchiveStatusRecord{}, false
	}
	return record, true
}

// parseOrgIDFromStatusKey recovers the organisation from a legacy key shaped
// `archive:preparation:status:<scope>:<orgId>:<scopeValue>`.
func parseOrgIDFromStatusKey(statusKey string) string {
	segments := strings.Split(statusKey, ":")
	if len(segments) < archiveStatusKeyMinSegments {
		return ""
	}
	return segments[archiveStatusKeySegmentOrg]
}
