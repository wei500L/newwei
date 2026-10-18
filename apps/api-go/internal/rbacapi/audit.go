package rbacapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
)

// roleCreateAudit is the AuditLog metadata written by createRole. Field names
// match the NestJS object literal.
type roleCreateAudit struct {
	RoleID      string   `json:"roleId"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

// roleAssignAudit is the AuditLog metadata written by assignRole.
type roleAssignAudit struct {
	TargetUserID string `json:"targetUserId"`
	RoleID       string `json:"roleId"`
}

// auditOutboxPayload mirrors createOutboxPayload in audit-log.writer.ts.
type auditOutboxPayload[T any] struct {
	OrgID     string  `json:"orgId"`
	ActorID   *string `json:"actorId"`
	Resource  string  `json:"resource"`
	Action    string  `json:"action"`
	Metadata  T       `json:"metadata"`
	IPAddress *string `json:"ipAddress"`
	CreatedAt string  `json:"createdAt"`
}

// writeAuditLogBestEffort 对齐 apps/api/src/modules/audit/audit-log.writer.ts 的
// writeAuditLogBestEffort：先写 AuditLog；失败则把等价 payload 入
// AuditLogOutbox 重试。两步都失败只记日志——绝不把已经创建的角色/分配
// 回滚成 500。
//
// metadata 由具名 struct 承载；泛型类型参数只是序列化边界，不使用
// map[string]any 搬运业务字段。
func writeAuditLogBestEffort[T any](ctx context.Context, db *sql.DB, orgID, actorID, resource, action string, metadata T) {
	if db == nil {
		return
	}
	metaRaw, err := json.Marshal(metadata)
	if err != nil {
		metaRaw = []byte("null")
	}
	now := nowMillis()
	if id, idErr := newRowID(); idErr == nil {
		_, err = db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, nullableString(actorID), resource, action, metaRaw, now)
		if err == nil {
			return
		}
	}

	// Outbox 回落：payload 与 NestJS createOutboxPayload 的字段一致。
	var actorPtr *string
	if actorID != "" {
		actorPtr = &actorID
	}
	payload := auditOutboxPayload[T]{
		OrgID:     orgID,
		ActorID:   actorPtr,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	payloadRaw, payloadErr := json.Marshal(payload)
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("rbac audit: failed to write audit log and outbox payload: %v", err)
		return
	}
	if _, outboxErr := db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payloadRaw, now, now, now); outboxErr != nil {
		log.Printf("rbac audit: failed to write audit log and enqueue outbox: %v", err)
	}
}
