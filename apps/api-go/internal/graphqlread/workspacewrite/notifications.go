package workspacewrite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
)

const notificationSelect = "SELECT `id`, `type`, `title`, `body`, `data`, `createdAt`, `readAt` " +
	"FROM `Notification` WHERE `id` = ? AND `orgId` = ? AND `userId` = ? LIMIT 1"

// markNotificationRead marks one of the caller's notifications read.
//
// The update and the reload are both limited to id + orgId + userId, so another
// organization, another user in the same organization, and an organization
// broadcast (userId NULL) can never be touched or read back. The row is not
// located through the update result: an already-read notification must still
// return its model.
//
// readAt is written only while it is still NULL, so the first read timestamp is
// preserved and a repeated call leaves readAt and updatedAt untouched. A
// missing row returns (nil, nil), which the resolver projects as GraphQL null.
func (s *service) markNotificationRead(ctx context.Context, orgID, userID, id string) (*history.NotificationModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `Notification` SET `readAt` = ?, `updatedAt` = ? "+
			"WHERE `id` = ? AND `orgId` = ? AND `userId` = ? AND `readAt` IS NULL",
		now, now, id, orgID, userID); err != nil {
		return nil, err
	}
	return loadNotification(ctx, s.db, orgID, userID, id)
}

// markAllNotificationsRead marks every unread notification of the caller read.
// It reports whether at least one row moved from unread to read. The rows are
// swept with a single statement; no notification is published and no queue job
// is created.
func (s *service) markAllNotificationsRead(ctx context.Context, orgID, userID string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errDatabaseUnavailable
	}
	now := nowMillis()
	result, err := s.db.ExecContext(ctx,
		"UPDATE `Notification` SET `readAt` = ?, `updatedAt` = ? "+
			"WHERE `orgId` = ? AND `userId` = ? AND `readAt` IS NULL",
		now, now, orgID, userID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// loadNotification reads one notification scoped to id + orgId + userId. A row
// that does not belong to the caller is reported as absent.
func loadNotification(ctx context.Context, q dbtx, orgID, userID, id string) (*history.NotificationModel, error) {
	var (
		rowID, kind, title string
		body               sql.NullString
		data               []byte
		createdAt          time.Time
		readAt             sql.NullTime
	)
	err := q.QueryRowContext(ctx, notificationSelect, id, orgID, userID).
		Scan(&rowID, &kind, &title, &body, &data, &createdAt, &readAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	model := history.NotificationModel{
		ID:        rowID,
		Type:      kind,
		Title:     title,
		Body:      nullStringPtr(body),
		Data:      jsonScalar(data),
		CreatedAt: createdAt.UTC(),
	}
	if readAt.Valid {
		seen := readAt.Time.UTC()
		model.ReadAt = &seen
	}
	return &model, nil
}

// markNotificationReadResolver reads the id argument and returns the nullable
// notification model.
func (s *service) markNotificationReadResolver(ctx contract.Context) (*history.NotificationModel, error) {
	id, err := requiredStringArg(ctx.Args, "id")
	if err == nil {
		var model *history.NotificationModel
		if model, err = s.markNotificationRead(callContext(ctx), ctx.Identity.OrgID, ctx.Identity.UserID, id); err == nil {
			return model, nil
		}
	}
	return nil, graphqlFailure(err)
}

// markAllNotificationsReadResolver returns whether any notification was marked
// read by this call.
func (s *service) markAllNotificationsReadResolver(ctx contract.Context) (bool, error) {
	changed, err := s.markAllNotificationsRead(callContext(ctx), ctx.Identity.OrgID, ctx.Identity.UserID)
	if err != nil {
		return false, graphqlFailure(err)
	}
	return changed, nil
}
