package crawlworkflow

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

// publishResult 是 POST /workflows/:id/publish 的响应 {workflow, version}。
type publishResult struct {
	Workflow workflowDocument `json:"workflow"`
	Version  versionDocument  `json:"version"`
}

// PublishWorkflow 对齐 publishWorkflow + 缺陷 1 的行锁修复：
//
//  1. 事务第一条语句锁工作流行：
//     SELECT id FROM CrawlStrategyWorkflow WHERE id = ? AND orgId = ? FOR UPDATE
//     没有行 → 404 Workflow not found（事务回滚）。
//  2. 下一条也是当前读：
//     SELECT COALESCE(MAX(version), 0) FROM CrawlStrategyWorkflowVersion
//     WHERE workflowId = ? FOR UPDATE
//     MySQL 默认可重复读时，锁等待之后的普通 SELECT 仍可能看到旧快照，
//     所以 MAX 这条必须是 FOR UPDATE。
//  3. nextVersion = 最大值 + 1；插入版本；再
//     UPDATE CrawlStrategyWorkflow SET description、publishedVersionId、
//     updatedById WHERE id = ? AND orgId = ?。
//  4. 唯一键冲突（1062）时在同一事务内重取 MAX 再插一次，不把 1062
//     返回成 500。
//
// NestJS 进程与 Go 进程会同时发布，因此用同一条 SQL、同一把行锁，
// 不做应用层 mutex。
func (s *Service) PublishWorkflow(ctx context.Context, orgID, actorID, id string, input publishInput) (publishResult, error) {
	row, err := s.loadWorkflow(ctx, s.db, id)
	if err != nil {
		return publishResult{}, err
	}
	if row.OrgID != orgID {
		return publishResult{}, errWorkflowMissing
	}

	versionName := row.Name
	if input.VersionName != nil {
		if trimmed := strings.TrimSpace(*input.VersionName); trimmed != "" {
			versionName = trimmed
		}
	}
	description := nullString(row.Description)
	if input.DescriptionSet {
		description = input.Description
	}
	definition := normalizeDefinition(row.DraftDefinition)
	if err := assertSupportedWorkflowDefinition(definition, "draftDefinition"); err != nil {
		return publishResult{}, err
	}
	definitionJSON, err := json.Marshal(definition)
	if err != nil {
		return publishResult{}, err
	}

	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return publishResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var lockedID string
	err = tx.QueryRowContext(ctx,
		"SELECT id FROM CrawlStrategyWorkflow WHERE id = ? AND orgId = ? FOR UPDATE",
		id, orgID).Scan(&lockedID)
	if err != nil {
		if err == sql.ErrNoRows {
			return publishResult{}, errWorkflowMissing
		}
		return publishResult{}, err
	}

	var version versionRow
	for attempt := 0; ; attempt++ {
		var maxVersion int64
		err = tx.QueryRowContext(ctx,
			"SELECT COALESCE(MAX(version), 0) FROM CrawlStrategyWorkflowVersion WHERE workflowId = ? FOR UPDATE",
			row.ID).Scan(&maxVersion)
		if err != nil {
			return publishResult{}, err
		}
		versionID, err := newRowID()
		if err != nil {
			return publishResult{}, err
		}
		version = versionRow{
			ID:          versionID,
			WorkflowID:  row.ID,
			OrgID:       orgID,
			Version:     int(maxVersion) + 1,
			Name:        versionName,
			Description: sqlNullString(description),
			Definition:  definitionJSON,
			CreatedByID: actorID,
			CreatedAt:   now,
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowVersion (id, workflowId, orgId, version, name, description, definition, createdById, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			version.ID, version.WorkflowID, version.OrgID, version.Version,
			version.Name, nullableString(description), []byte(definitionJSON), actorID, now)
		if err != nil && uniqueConflict(err) && attempt == 0 {
			// 唯一冲突：同一事务内重取 MAX 再插一次。
			continue
		}
		if err != nil {
			return publishResult{}, err
		}
		break
	}

	result, err := tx.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflow SET description = ?, publishedVersionId = ?, updatedById = ?, updatedAt = ?
WHERE id = ? AND orgId = ?`,
		nullableString(description), version.ID, actorID, now, id, orgID)
	if err != nil {
		return publishResult{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return publishResult{}, err
	}
	if affected != 1 {
		return publishResult{}, errWorkflowMissing
	}
	if err := tx.Commit(); err != nil {
		return publishResult{}, err
	}

	updated, err := s.loadWorkflow(ctx, s.db, row.ID)
	if err != nil {
		return publishResult{}, err
	}
	document, err := s.loadWorkflowDocument(ctx, s.db, updated)
	if err != nil {
		return publishResult{}, err
	}
	return publishResult{
		Workflow: document,
		Version:  mapWorkflowVersion(version),
	}, nil
}
