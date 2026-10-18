package history

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

// notificationListSQL's order is only ASC or DESC, chosen in this file.
// A negative Nest take reverses createdAt, limits to the absolute value, then
// restores descending order. That is Prisma's negative take, not LIMIT -n.
const notificationListSQL = `
SELECT id, type, title, body, data, createdAt, readAt
FROM Notification
WHERE orgId = ? AND userId = ?
ORDER BY createdAt %s
LIMIT ?`

const notificationCountSQL = `
SELECT COUNT(*)
FROM Notification
WHERE orgId = ? AND userId = ? AND readAt IS NULL`

// listNotifications returns only this user's rows. Another user in the same org does not match userId.
func (s *service) listNotifications(ctx context.Context, orgID, userID string, take int) ([]NotificationModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	if take == 0 {
		return []NotificationModel{}, nil
	}
	order := "DESC"
	limit := take
	reverse := false
	if take < 0 {
		if take == math.MinInt {
			return nil, errors.New("notification take overflow")
		}
		order = "ASC"
		limit = -take
		reverse = true
	}
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(notificationListSQL, order), orgID, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]NotificationModel, 0)
	for rows.Next() {
		var (
			id, kind, title string
			body            sql.NullString
			data            []byte
			createdAt       time.Time
			readAt          sql.NullTime
		)
		if err := rows.Scan(&id, &kind, &title, &body, &data, &createdAt, &readAt); err != nil {
			return nil, err
		}
		row := NotificationModel{
			Body:      nullStringPtr(body),
			CreatedAt: createdAt,
			Data:      jsonScalar(data),
			ID:        id,
			Title:     title,
			Type:      kind,
		}
		if readAt.Valid {
			seen := readAt.Time
			row.ReadAt = &seen
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if reverse {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out, nil
}

func (s *service) countUnread(ctx context.Context, orgID, userID string) (int, error) {
	if s == nil || s.db == nil {
		return 0, errDatabaseUnavailable
	}
	var count int64
	if err := s.db.QueryRowContext(ctx, notificationCountSQL, orgID, userID).Scan(&count); err != nil {
		return 0, err
	}
	if count > int64(math.MaxInt) {
		return 0, errors.New("unread notification count overflows int")
	}
	return int(count), nil
}

// jsonScalar converts a nullable MySQL JSON column into the JSON scalar the
// projection layer expects. An empty column and a literal JSON null both become
// nil, which projects as GraphQL null instead of a quoted empty string.
func jsonScalar(raw []byte) *json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	message := json.RawMessage(append([]byte(nil), trimmed...))
	return &message
}
