package realtimesocket

import (
	"encoding/json"
	"log"
	"sort"
)

// PublishRooms is the B1 local push: it walks only the sockets of this process
// in the namespace, selecting them with socket.io room semantics (empty rooms
// means every socket of the namespace, several rooms are unioned, except rooms
// and except socket ids are removed). The payload bytes are spliced into the
// EVENT frame verbatim, so DTO field order is never rewritten. The Redis
// adapter is never touched.
func (r *Runtime) PublishRooms(namespace string, rooms, except []string, event string, payloadJSON json.RawMessage) {
	if r == nil || r.closing.Load() || event == "" {
		return
	}
	if len(payloadJSON) > 0 && !json.Valid(payloadJSON) {
		log.Printf("realtimesocket: dropping %s event %q with invalid JSON payload", namespace, event)
		return
	}
	r.mu.RLock()
	index := r.namespaces[namespace]
	var targets []*socketState
	if index != nil {
		targets = index.selectRooms(rooms, except)
	}
	r.mu.RUnlock()
	r.dispatch(targets, event, payloadJSON)
}

// PublishOrg pushes one event to the org:<orgID> room of the namespace
// (UserSessionManager.emitToOrg).
func (r *Runtime) PublishOrg(namespace, orgID, event string, payloadJSON json.RawMessage) {
	r.PublishRooms(namespace, []string{orgRoom(orgID)}, nil, event, payloadJSON)
}

// PublishUser pushes one event to one user of one organization. The user room
// and the org room are intersected, so a user id that exists in several
// organizations cannot receive another tenant's event
// (UserSessionManager.emitToUser).
func (r *Runtime) PublishUser(namespace, orgID, userID, event string, payloadJSON json.RawMessage) {
	if r == nil || r.closing.Load() || event == "" {
		return
	}
	if len(payloadJSON) > 0 && !json.Valid(payloadJSON) {
		log.Printf("realtimesocket: dropping %s event %q with invalid JSON payload", namespace, event)
		return
	}
	r.mu.RLock()
	index := r.namespaces[namespace]
	var targets []*socketState
	if index != nil {
		for state := range index.rooms[userRoom(userID)] {
			if state.identity.OrgID == orgID {
				targets = append(targets, state)
			}
		}
	}
	r.mu.RUnlock()
	r.dispatch(targets, event, payloadJSON)
}

// LocalOrgIDs returns the distinct organization ids with at least one local
// socket in the namespace. The order is deterministic (ascending) but callers
// should not depend on it.
func (r *Runtime) LocalOrgIDs(namespace string) []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	index := r.namespaces[namespace]
	if index == nil {
		return nil
	}
	seen := make(map[string]struct{}, len(index.rooms)/3)
	for _, state := range index.sockets {
		if state.identity.OrgID != "" {
			seen[state.identity.OrgID] = struct{}{}
		}
	}
	return sortedKeys(seen)
}

// LocalUsers returns the distinct user ids with a local socket in the namespace
// for one organization.
func (r *Runtime) LocalUsers(namespace, orgID string) []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	index := r.namespaces[namespace]
	if index == nil {
		return nil
	}
	seen := make(map[string]struct{})
	for _, state := range index.sockets {
		if state.identity.OrgID == orgID && state.identity.UserID != "" {
			seen[state.identity.UserID] = struct{}{}
		}
	}
	return sortedKeys(seen)
}

// dispatch writes one EVENT frame to each selected socket. A socket appears at
// most once because selectRooms de-duplicates by state. Write failures close the
// affected connection: the socket is unusable and its Disconnect callback will
// clean the registry.
func (r *Runtime) dispatch(targets []*socketState, event string, payloadJSON json.RawMessage) {
	for _, state := range targets {
		if err := state.session.Send(event, payloadJSON); err != nil {
			state.session.Disconnect()
		}
	}
}

func sortedKeys(set map[string]struct{}) []string {
	if len(set) == 0 {
		return nil
	}
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
