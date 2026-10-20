package economicdata

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

type presetAuditMetadata struct {
	Preset      string   `json:"preset"`
	CategoryKey string   `json:"categoryKey"`
	SlugCount   int      `json:"slugCount"`
	Slugs       []string `json:"slugs"`
}

type upgradeRequestedMetadata struct {
	RequestID      string `json:"requestId"`
	BeforeVersion  string `json:"beforeVersion"`
	GatewayBaseURL string `json:"gatewayBaseUrl"`
}

type upgradeSucceededMetadata struct {
	RequestID     string  `json:"requestId"`
	BeforeVersion string  `json:"beforeVersion"`
	AfterVersion  *string `json:"afterVersion"`
	DurationMs    int64   `json:"durationMs"`
	Note          string  `json:"note,omitempty"`
	PipStdout     string  `json:"pipStdout"`
	PipStderr     string  `json:"pipStderr"`
}

type upgradeFailedMetadata struct {
	RequestID     string `json:"requestId"`
	BeforeVersion string `json:"beforeVersion"`
	Error         string `json:"error"`
	DurationMs    int64  `json:"durationMs"`
	PipStdout     string `json:"pipStdout"`
	PipStderr     string `json:"pipStderr"`
}

type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors the shared NestJS audit writer. A failure of
// both the direct insert and the outbox is logged, never returned: the business
// action (enqueued jobs or an accepted upgrade) has already happened.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, resource, action string, metadata any, ipAddress *string) {
	if s == nil || s.db == nil || orgID == "" {
		return
	}
	rawMetadata, err := json.Marshal(metadata)
	if err != nil {
		log.Printf("economicdata: build audit metadata for %s: %v", action, err)
		return
	}
	var actor any
	if actorID != "" {
		actor = actorID
	}
	var ip any
	if ipAddress != nil {
		ip = *ipAddress
	}
	now := time.Now().UTC()
	if id, idErr := newRowID(); idErr == nil {
		_, insertErr := s.db.ExecContext(ctx,
			"INSERT INTO `AuditLog` (`id`,`orgId`,`actorId`,`resource`,`action`,`metadata`,`ipAddress`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)",
			id, orgID, actor, resource, action, rawMetadata, ip, now)
		if insertErr == nil {
			return
		}
		log.Printf("economicdata: direct audit insert failed, enqueueing outbox: %v", insertErr)
	}
	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   nullableActor(actorID),
		Resource:  resource,
		Action:    action,
		Metadata:  rawMetadata,
		IPAddress: ipAddress,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, outboxErr := newRowID()
	if payloadErr != nil || outboxErr != nil {
		log.Printf("economicdata: build audit outbox payload for %s failed", action)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `AuditLogOutbox` (`id`,`orgId`,`payload`,`status`,`attempts`,`availableAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,'pending',0,?,?,?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("economicdata: write audit outbox for %s failed: %v", action, err)
	}
}

func nullableActor(actorID string) *string {
	if actorID == "" {
		return nil
	}
	return &actorID
}
