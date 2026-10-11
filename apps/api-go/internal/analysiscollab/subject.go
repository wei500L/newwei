package analysiscollab

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// AssertSubjectReadable 是讨论读取和卡片关联使用的主体检查。
// 私有视图对非创建者返回 Analysis subject not found，即使用户有 users.write。
// analysis_task 必须挂在未归档看板上。item 查 ItemMeta，event 查 NewsEvent，都限制 orgId。
func AssertSubjectReadable(ctx context.Context, q Querier, orgID, userID, subjectType, subjectID string) error {
	switch subjectType {
	case SubjectSavedView:
		return assertSavedViewReadable(ctx, q, orgID, userID, subjectID)
	case SubjectItem:
		return assertRow(ctx, q, "SELECT `id` FROM `ItemMeta` WHERE `orgId` = ? AND `id` = ?", orgID, subjectID)
	case SubjectEvent:
		return assertRow(ctx, q, "SELECT `id` FROM `NewsEvent` WHERE `orgId` = ? AND `id` = ?", orgID, subjectID)
	case SubjectAnalysisTask:
		return assertRow(ctx, q, "SELECT t.`id` FROM `AnalysisTaskCard` t INNER JOIN `AnalysisBoard` b ON b.`id` = t.`boardId` AND b.`orgId` = t.`orgId` WHERE t.`orgId` = ? AND t.`id` = ? AND b.`archivedAt` IS NULL", orgID, subjectID)
	default:
		return NotFound(MsgSubjectNotFound)
	}
}

func assertSavedViewReadable(ctx context.Context, q Querier, orgID, userID, viewID string) error {
	var createdByID, visibility string
	err := q.QueryRowContext(ctx, "SELECT `createdById`, `visibility` FROM `SavedAnalysisView` WHERE `orgId` = ? AND `id` = ?", orgID, viewID).Scan(&createdByID, &visibility)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !CanReadSavedView(createdByID, visibility, userID)) {
		return NotFound(MsgSubjectNotFound)
	}
	return err
}

func assertRow(ctx context.Context, q Querier, query, orgID, subjectID string) error {
	var id string
	err := q.QueryRowContext(ctx, query, orgID, subjectID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return NotFound(MsgSubjectNotFound)
	}
	return err
}

// LockSubjectForWrite 在写入讨论之前锁住会被删除的主体。
// saved_view 锁视图行；analysis_task 锁看板行后复查任务仍在 active 看板。
// item 和 event 只复查存在性，并发首建交给唯一约束。
func LockSubjectForWrite(ctx context.Context, tx *sql.Tx, orgID, userID, subjectType, subjectID string) error {
	switch subjectType {
	case SubjectSavedView:
		row, err := LockSavedView(ctx, tx, orgID, subjectID)
		if err != nil {
			return err
		}
		if !row.Found || !CanReadSavedView(row.CreatedByID, row.Visibility, userID) {
			return NotFound(MsgSubjectNotFound)
		}
		return nil
	case SubjectAnalysisTask:
		var boardID string
		err := tx.QueryRowContext(ctx, "SELECT `boardId` FROM `AnalysisTaskCard` WHERE `orgId` = ? AND `id` = ?", orgID, subjectID).Scan(&boardID)
		if errors.Is(err, sql.ErrNoRows) {
			return NotFound(MsgSubjectNotFound)
		}
		if err != nil {
			return err
		}
		if _, err := LockBoard(ctx, tx, orgID, boardID); err != nil {
			return err
		}
		return AssertSubjectReadable(ctx, tx, orgID, userID, subjectType, subjectID)
	case SubjectItem, SubjectEvent:
		return AssertSubjectReadable(ctx, tx, orgID, userID, subjectType, subjectID)
	default:
		return NotFound(MsgSubjectNotFound)
	}
}

// ParseSubjectType 对齐 ParseEnumPipe。非法值是 400，文案固定。
func ParseSubjectType(value string) (string, error) {
	switch value {
	case SubjectSavedView, SubjectItem, SubjectEvent, SubjectAnalysisTask:
		return value, nil
	default:
		return "", BadRequest(MsgEnumParam)
	}
}

// LinkedSubject 是卡片关联。两个都空时 ok 且指针为 nil。只给一个则 400。
// 非空时调用 assert，analysis_task 不能从这里进来。
type LinkedSubject struct {
	Type string
	ID   string
}

func ResolveLinkedSubject(ctx context.Context, q Querier, orgID, userID string, subjectType *string, subjectID *string) (*LinkedSubject, error) {
	var normalizedID string
	if subjectID != nil {
		normalizedID = strings.TrimSpace(*subjectID)
	}
	typeValue := ""
	if subjectType != nil {
		typeValue = *subjectType
	}
	if typeValue == "" && normalizedID == "" {
		return nil, nil
	}
	if typeValue == "" || normalizedID == "" {
		return nil, BadRequest(MsgLinkedTogether)
	}
	if typeValue != SubjectSavedView && typeValue != SubjectItem && typeValue != SubjectEvent {
		return nil, BadRequest(MsgLinkedTogether)
	}
	if err := AssertSubjectReadable(ctx, q, orgID, userID, typeValue, normalizedID); err != nil {
		return nil, err
	}
	return &LinkedSubject{Type: typeValue, ID: normalizedID}, nil
}

// ResolveAssignee 要求同组织 active membership，且 User.isActive。空值返回 nil。
func ResolveAssignee(ctx context.Context, q Querier, orgID string, assigneeID *string) (*string, error) {
	if assigneeID == nil {
		return nil, nil
	}
	normalized := strings.TrimSpace(*assigneeID)
	if normalized == "" {
		return nil, nil
	}
	var userID string
	err := q.QueryRowContext(ctx, "SELECT m.`userId` FROM `Membership` m INNER JOIN `User` u ON u.`id` = m.`userId` WHERE m.`orgId` = ? AND m.`userId` = ? AND m.`isActive` = 1 AND u.`isActive` = 1 LIMIT 1", orgID, normalized).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, BadRequest(MsgAssignee)
	}
	if err != nil {
		return nil, err
	}
	return &userID, nil
}

// MustUser 在组装响应时缺少用户行就失败，避免返回半份 actor。
func MustUser(users map[string]UserSummary, id string) (UserSummary, error) {
	user, ok := users[id]
	if !ok || user.ID == "" {
		return UserSummary{}, fmt.Errorf("analysis: user %s is missing", id)
	}
	return user, nil
}
