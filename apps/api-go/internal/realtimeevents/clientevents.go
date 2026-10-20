package realtimeevents

import (
	"encoding/json"
	"log"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

// HandleClientEvent implements realtimesocket.ClientEvents. It receives every
// browser EVENT forwarded by the transport; only the newsnow
// newsnow:set-active-sources event changes state here.
//
// Callbacks run synchronously on the connection goroutine, so this method only
// updates the in-memory registry (no Redis or database call).
func (s *Sources) HandleClientEvent(namespace string, identity realtimesocket.ClientIdentity, event string, args json.RawMessage) {
	if s == nil || namespace != NamespaceNewsnow || event != "newsnow:set-active-sources" {
		return
	}
	// Before the namespace CONNECT completes the identity has no organization;
	// the NestJS gateway buffers such a frame until authentication finishes. The
	// browser sends the event after connect, so ignoring it here mirrors the
	// observable contract without buffering another payload shape.
	if identity.OrgID == "" || identity.SocketID == "" {
		return
	}
	payload, ok := newsnowSetActiveSourcesPayloadFromArgs(args)
	if !ok {
		s.newsnow.set(identity.SocketID, identity.OrgID, nil)
		return
	}
	normalized := normalizeNewsnowActiveSourceIDs(payload.SourceIDs, s.options.KnownSource)
	if normalized.truncated > 0 {
		log.Printf("realtimeevents: newsnow active source list truncated: orgId=%s socketId=%s kept=%d dropped=%d max=%d",
			identity.OrgID, identity.SocketID, len(normalized.ids), normalized.truncated, maxNewsnowActiveSourceIDs)
	}
	s.newsnow.set(identity.SocketID, identity.OrgID, normalized.ids)
}

// HandleClientDisconnect implements realtimesocket.ClientEvents. It drops the
// registry entry of the closed namespace socket.
func (s *Sources) HandleClientDisconnect(namespace string, identity realtimesocket.ClientIdentity) {
	if s == nil || namespace != NamespaceNewsnow {
		return
	}
	s.newsnow.remove(identity.SocketID)
}
