package analysiscollab

import (
	"context"
	"database/sql"
	"fmt"
)

// LoadUsers 读取响应里的 createdBy、updatedBy 和 assignee。缺行返回错误。
func LoadUsers(ctx context.Context, q Querier, ids []string) (map[string]UserSummary, error) {
	unique := uniqueIDs(ids)
	out := make(map[string]UserSummary, len(unique))
	if len(unique) == 0 {
		return out, nil
	}
	args := make([]any, len(unique))
	for i, id := range unique {
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, "SELECT `id`, `email`, `firstName`, `lastName`, `avatarUrl` FROM `User` WHERE `id` IN ("+placeholders(len(unique))+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var user UserSummary
		var avatar sql.NullString
		if err := rows.Scan(&user.ID, &user.Email, &user.FirstName, &user.LastName, &avatar); err != nil {
			return nil, err
		}
		user.AvatarURL = TextPtr(avatar)
		out[user.ID] = user
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, id := range unique {
		if _, ok := out[id]; !ok {
			return nil, fmt.Errorf("analysis: user %s is missing", id)
		}
	}
	return out, nil
}
