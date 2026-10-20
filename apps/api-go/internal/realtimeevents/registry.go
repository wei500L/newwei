package realtimeevents

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Newsnow active-source registry.
//
// The NestJS gateway keeps a process-local map of the source ids each socket
// asked to follow (NewsnowActiveSourceRegistryService) and both the legacy
// fetch path and the Go source-refresh relay subscriber use it to decide which
// organizations must receive a newsnow:update. Once the browser sockets connect
// to the Go transport, the NestJS registry is empty, so realtimeevents keeps the
// same map from the browser events forwarded by realtimesocket.
type newsnowRegistry struct {
	mu       sync.RWMutex
	sessions map[string]newsnowSession
}

type newsnowSession struct {
	orgID     string
	sourceIDs []string
}

func newNewsnowRegistry() *newsnowRegistry {
	return &newsnowRegistry{sessions: map[string]newsnowSession{}}
}

// set stores (or replaces) the followed sources of one namespace socket. An
// empty orgID or an empty source list deletes the entry, exactly like
// NewsnowActiveSourceRegistryService.setActiveSources.
func (r *newsnowRegistry) set(socketID, orgID string, sourceIDs []string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if socketID == "" || orgID == "" || len(sourceIDs) == 0 {
		delete(r.sessions, socketID)
		return
	}
	r.sessions[socketID] = newsnowSession{orgID: orgID, sourceIDs: sourceIDs}
}

// remove deletes one socket entry.
func (r *newsnowRegistry) remove(socketID string) {
	if r == nil || socketID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, socketID)
}

// orgIDsForSource returns the distinct organizations of this process that
// follow sourceID, sorted for deterministic publishing.
func (r *newsnowRegistry) orgIDsForSource(sourceID string) []string {
	if r == nil || sourceID == "" {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := map[string]struct{}{}
	for _, session := range r.sessions {
		for _, candidate := range session.sourceIDs {
			if candidate == sourceID {
				seen[session.orgID] = struct{}{}
				break
			}
		}
	}
	orgIDs := make([]string, 0, len(seen))
	for orgID := range seen {
		orgIDs = append(orgIDs, orgID)
	}
	sort.Strings(orgIDs)
	return orgIDs
}

// hasSource reports whether one organization follows sourceID on this process.
func (r *newsnowRegistry) hasSource(orgID, sourceID string) bool {
	if r == nil || orgID == "" || sourceID == "" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, session := range r.sessions {
		if session.orgID != orgID {
			continue
		}
		for _, candidate := range session.sourceIDs {
			if candidate == sourceID {
				return true
			}
		}
	}
	return false
}

// activeSourceCount is used by tests to assert cleanup.
func (r *newsnowRegistry) activeSourceCount() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.sessions)
}

const maxNewsnowActiveSourceIDs = 60

// newsnowSourceIDPattern mirrors the NestJS /^[a-z0-9_-]+$/i guard.
var newsnowSourceIDPattern = regexp.MustCompile(`(?i)^[a-z0-9_-]+$`)

// newsnowSetActiveSourcesPayload is the browser payload of
// newsnow:set-active-sources. sourceIds is a loose JSON value because the
// browser payload is untrusted; invalid shapes normalize to an empty list.
type newsnowSetActiveSourcesPayload struct {
	SourceIDs json.RawMessage `json:"sourceIds"`
}

// newsnowActiveSourceIDs is the normalized source list plus the number of
// entries dropped by the server-side cap (logged by the caller).
type newsnowActiveSourceIDs struct {
	ids       []string
	truncated int
}

// normalizeNewsnowActiveSourceIDs mirrors normalizeActiveSourceIds:
// non-array -> empty; each entry must be a string that trims non-empty, matches
// the id pattern, is not a duplicate, and (when knownSource is provided) exists
// in the generated registry metadata; at most 60 ids are kept. Truncation is
// counted, not an error.
//
// KnownSource is optional because the Go realtimeevents package does not own the
// newsnow registry metadata; when it is nil only the syntax rules are applied
// (documented subset).
func normalizeNewsnowActiveSourceIDs(raw json.RawMessage, knownSource func(string) bool) newsnowActiveSourceIDs {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return newsnowActiveSourceIDs{}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return newsnowActiveSourceIDs{}
	}
	result := newsnowActiveSourceIDs{}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		var candidate string
		if err := json.Unmarshal(entry, &candidate); err != nil {
			continue
		}
		sourceID := strings.TrimSpace(candidate)
		if sourceID == "" {
			continue
		}
		if !newsnowSourceIDPattern.MatchString(sourceID) {
			continue
		}
		if _, exists := seen[sourceID]; exists {
			continue
		}
		if knownSource != nil && !knownSource(sourceID) {
			continue
		}
		if len(result.ids) >= maxNewsnowActiveSourceIDs {
			result.truncated++
			continue
		}
		seen[sourceID] = struct{}{}
		result.ids = append(result.ids, sourceID)
	}
	return result
}

// newsnowSetActiveSourcesPayloadFromArgs extracts the first event argument of a
// forwarded client event. The browser emits one object, so the args value is a
// JSON array with a single element.
func newsnowSetActiveSourcesPayloadFromArgs(args json.RawMessage) (newsnowSetActiveSourcesPayload, bool) {
	if len(args) == 0 {
		return newsnowSetActiveSourcesPayload{}, false
	}
	var rawArgs []json.RawMessage
	if err := json.Unmarshal(args, &rawArgs); err != nil || len(rawArgs) == 0 {
		return newsnowSetActiveSourcesPayload{}, false
	}
	var payload newsnowSetActiveSourcesPayload
	if err := json.Unmarshal(rawArgs[0], &payload); err != nil {
		return newsnowSetActiveSourcesPayload{}, false
	}
	return payload, true
}
