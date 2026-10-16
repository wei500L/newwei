package rbacapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
)

// writeAuditLogBestEffort 对齐 apps/api/src/modules/audit/audit-log.writer.ts 的
// writeAuditLogBestEffort：先写 AuditLog；失败则把等价 payload 入
// AuditLogOutbox 重试。两步都失败只记日志——绝不把已经创建的角色/分配
// 回滚成 500。
func writeAuditLogBestEffort(ctx context.Context, db *sql.DB, orgID, actorID, resource, action string, metadata map[string]any) {
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
	payload := map[string]any{
		"orgId":     orgID,
		"actorId":   nullableString(actorID),
		"resource":  resource,
		"action":    action,
		"metadata":  metadata,
		"ipAddress": nil,
		"createdAt": now.UTC().Format("2006-01-02T15:04:05.000Z"),
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
