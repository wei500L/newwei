package alerts

import (
	"context"
	"database/sql"
)

const channelSelect = "SELECT `id`, `name`, `type`, `target`, `isActive`, `config`, `createdAt`, `updatedAt` " +
	"FROM `AlertNotificationChannel` WHERE `orgId` = ? ORDER BY `createdAt` ASC"

func listChannels(ctx context.Context, db *sql.DB, orgID string) ([]AlertChannelModel, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, channelSelect, orgID)
	if err != nil {
		return nil, queryErr("list channels", err)
	}
	defer rows.Close()

	channels := make([]AlertChannelModel, 0)
	for rows.Next() {
		var (
			channel AlertChannelModel
			config  []byte
		)
		if err := rows.Scan(
			&channel.ID,
			&channel.Name,
			&channel.Type,
			&channel.Target,
			&channel.IsActive,
			&config,
			&channel.CreatedAt,
			&channel.UpdatedAt,
		); err != nil {
			return nil, queryErr("scan channel", err)
		}
		decoded, err := decodeJSON(config)
		if err != nil {
			return nil, err
		}
		channel.Config = decoded
		channel.CreatedAt = utcTime(channel.CreatedAt)
		channel.UpdatedAt = utcTime(channel.UpdatedAt)
		channels = append(channels, channel)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list channels", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list channels", err)
	}
	return channels, nil
}
