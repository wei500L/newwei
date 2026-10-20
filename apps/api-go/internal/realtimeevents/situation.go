package realtimeevents

import (
	"context"
	"encoding/json"
	"log"
	"strings"
)

// Situation-monitor event bridge.
//
// When API_GO_REALTIME_SOCKET_MODE=go the NestJS dispatcher publishes the same
// global signal event it hands to the in-process listeners on
// situation-monitor:signals:events:v1. The payload is the un-augmented signal;
// per-user monitor matches are added here for the users connected to this
// process (one local query per organization, never a per-user database walk).
// If the augmenter is unavailable or fails, the original payload is pushed
// unchanged, which is exactly the NestJS gateway fallback (the monitorMatches /
// alertMonitorMatches keys are then absent).

const (
	situationTelegramUpdate = "situation:telegram.update"
	situationOrefUpdate     = "situation:oref.update"
)

// situationBridgeMessage is the dispatcher bridge document.
type situationBridgeMessage struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp string          `json:"timestamp"`
}

// parseSituationBridge validates the bridge contract. The payload must be a
// JSON object; the dispatcher always publishes an object for these two types.
func parseSituationBridge(raw []byte) (situationBridgeMessage, bool) {
	var message situationBridgeMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return situationBridgeMessage{}, false
	}
	if message.Version != 1 {
		return situationBridgeMessage{}, false
	}
	switch message.Type {
	case situationTelegramUpdate, situationOrefUpdate:
	default:
		return situationBridgeMessage{}, false
	}
	if len(message.Payload) == 0 || !isJSONObject(message.Payload) {
		return situationBridgeMessage{}, false
	}
	if strings.TrimSpace(message.Timestamp) == "" {
		return situationBridgeMessage{}, false
	}
	return message, true
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return false
	}
	return json.Valid(raw)
}

// openSituationSubscription subscribes to the dispatcher bridge channel.
func (s *Sources) openSituationSubscription(ctx context.Context) error {
	client := s.newSubscriptionClient()
	pubsub, err := s.subscribeChannel(ctx, client, s.options.BridgeChannel)
	if err != nil {
		return err
	}
	s.bridgeSub = pubsub
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.readPubSub(ctx, pubsub, func(_ string, payload []byte) {
			s.handleSituationBridge(ctx, payload)
		})
	}()
	return nil
}

// handleSituationBridge augments the payload per organization and pushes it to
// each local user session. A failed augmentation falls back to the original
// payload per user instead of dropping the event.
func (s *Sources) handleSituationBridge(ctx context.Context, raw []byte) {
	message, ok := parseSituationBridge(raw)
	if !ok {
		log.Printf("realtimeevents: ignoring malformed situation bridge message on %s", s.options.BridgeChannel)
		return
	}
	sink := s.sinkSnapshot()
	if sink == nil {
		return
	}
	orgIDs := sink.LocalOrgIDs(NamespaceSituationMonitor)
	for _, orgID := range orgIDs {
		users := normalizeUserIDs(sink.LocalUsers(NamespaceSituationMonitor, orgID))
		if len(users) == 0 {
			continue
		}
		augmented := map[string]json.RawMessage{}
		if s.options.Situation != nil {
			result, err := s.options.Situation.AugmentRealtime(ctx, message.Type, orgID, users, message.Payload)
			if err != nil {
				log.Printf("realtimeevents: situation payload augmentation failed; falling back to the raw payload: orgId=%s type=%s err=%v", orgID, message.Type, err)
			} else {
				augmented = result
			}
		}
		for _, userID := range users {
			payloadJSON := message.Payload
			if candidate := augmented[userID]; len(candidate) > 0 {
				payloadJSON = candidate
			}
			sink.PublishUser(NamespaceSituationMonitor, orgID, userID, message.Type, payloadJSON)
		}
	}
}

// normalizeUserIDs mirrors normalizeUserIds: trim, drop empty values and dedupe
// while preserving the first occurrence order.
func normalizeUserIDs(values []string) []string {
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
