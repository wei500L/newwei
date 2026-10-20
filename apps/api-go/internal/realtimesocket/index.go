package realtimesocket

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/socketio"
)

// socketState is the local bookkeeping of one connected namespace socket: the
// protocol session, its DB-derived identity, the joins of the local room index
// and the token metadata used by the B2 revalidation loop.
type socketState struct {
	session *socketio.Session
	spec    *namespaceSpec
	// identity is derived from the authorizing MySQL lookup (not from unsigned
	// token claims): authorization.UserID/OrgID are the canonical values.
	identity  ClientIdentity
	ip        string
	jti       string
	expiresAt time.Time
	rooms     []string
}

// namespaceIndex owns the namespace-scoped socket registry and the socket.io
// room index of this process. Connection caps are counted per namespace, which
// mirrors UserSessionManager.register: a user may occupy five sockets in
// /newsnow and five more in /queue without interfering.
type namespaceIndex struct {
	sockets map[string]*socketState
	rooms   map[string]map[*socketState]struct{}
}

func newNamespaceIndex() *namespaceIndex {
	return &namespaceIndex{
		sockets: map[string]*socketState{},
		rooms:   map[string]map[*socketState]struct{}{},
	}
}

// newSocketState derives the room membership of a namespace socket:
// org:<orgId>, user:<userId>, ip:<ip> when known and any namespace-specific
// extra room (the situation-monitor global room).
func newSocketState(session *socketio.Session, spec *namespaceSpec, identity ClientIdentity, ip, jti string, expiresAt time.Time) *socketState {
	rooms := make([]string, 0, 4)
	rooms = append(rooms, orgRoom(identity.OrgID), userRoom(identity.UserID))
	if ip != "" {
		rooms = append(rooms, ipRoom(ip))
	}
	rooms = append(rooms, spec.extraRooms...)
	return &socketState{
		session:   session,
		spec:      spec,
		identity:  identity,
		ip:        ip,
		jti:       jti,
		expiresAt: expiresAt,
		rooms:     rooms,
	}
}

func (i *namespaceIndex) add(state *socketState) {
	i.sockets[state.session.SID] = state
	for _, room := range state.rooms {
		members := i.rooms[room]
		if members == nil {
			members = map[*socketState]struct{}{}
			i.rooms[room] = members
		}
		members[state] = struct{}{}
	}
}

func (i *namespaceIndex) remove(state *socketState) bool {
	if i == nil || state == nil {
		return false
	}
	if current, ok := i.sockets[state.session.SID]; !ok || current != state {
		return false
	}
	delete(i.sockets, state.session.SID)
	for _, room := range state.rooms {
		members := i.rooms[room]
		if members == nil {
			continue
		}
		delete(members, state)
		if len(members) == 0 {
			delete(i.rooms, room)
		}
	}
	return true
}

func (i *namespaceIndex) socket(sid string) *socketState {
	if i == nil {
		return nil
	}
	return i.sockets[sid]
}

// selectRooms implements the socket.io broadcast selection used by the local
// push API: an empty room list targets every socket of the namespace, several
// rooms are unioned, and every socket belonging to an except room (or matching
// an except socket id) is removed. The returned slice is a snapshot; callers
// must not hold the runtime lock while writing to the sockets.
func (i *namespaceIndex) selectRooms(rooms, except []string) []*socketState {
	selected := make(map[*socketState]struct{})
	if len(rooms) == 0 {
		for _, state := range i.sockets {
			selected[state] = struct{}{}
		}
	} else {
		for _, room := range rooms {
			for state := range i.rooms[room] {
				selected[state] = struct{}{}
			}
		}
	}
	for _, room := range except {
		for state := range i.rooms[room] {
			delete(selected, state)
		}
		// socket.io also treats a socket id as a one-member room.
		if state, ok := i.sockets[room]; ok {
			delete(selected, state)
		}
	}
	targets := make([]*socketState, 0, len(selected))
	for state := range selected {
		targets = append(targets, state)
	}
	return targets
}
