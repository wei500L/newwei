package newsnowsources

import (
	"context"
	"encoding/json"
	"log"
	"strings"
)

// sourceRefreshChannel is the source-specific relay channel consumed by the
// NestJS subscriber. It carries no orgId, user or secret: the subscriber derives
// the target organizations from its authenticated socket registry.
const sourceRefreshChannel = "newsnow:source-refresh:v1"

// sourceRefreshMessage is the typed relay payload.
type sourceRefreshMessage struct {
	Version       int      `json:"version"`
	RefreshID     string   `json:"refreshId"`
	SourceID      string   `json:"sourceId"`
	NewItemsCount int      `json:"newItemsCount"`
	TopTitles     []string `json:"topTitles"`
	UpdatedTime   string   `json:"updatedTime"`
	IntervalMs    int      `json:"intervalMs"`
}

// publishRefresh mirrors publishRealtimeUpdate's incremental algorithm and
// publishes one message per successful refresh. Relay failures only log: the
// cache and HTTP response are already committed.
func (s *Service) publishRefresh(ctx context.Context, sourceID string, interval int, previous *SourceResponse, current SourceResponse) {
	if previous == nil || len(previous.Items) == 0 {
		return
	}
	previousIDs := make(map[string]struct{}, len(previous.Items))
	for _, item := range previous.Items {
		previousIDs[item.ID.String()] = struct{}{}
	}

	newItemsCount := 0
	topTitles := make([]string, 0, 3)
	for _, item := range current.Items {
		if _, exists := previousIDs[item.ID.String()]; exists {
			continue
		}
		newItemsCount++
		trimmed := strings.TrimSpace(item.Title)
		if len(topTitles) < 3 && trimmed != "" {
			topTitles = append(topTitles, sliceUTF16(trimmed, 200))
		}
	}
	if newItemsCount <= 0 {
		return
	}

	updatedTime := ""
	if number, ok := current.UpdatedTime.Number(); ok {
		updatedTime = isoMillis(int64(number))
	} else if text, ok := current.UpdatedTime.StringValue(); ok && strings.TrimSpace(text) != "" {
		updatedTime = text
	} else {
		updatedTime = isoMillis(millisOf(s.now()))
	}

	refreshID, err := newLockToken()
	if err != nil {
		log.Printf("newsnowsources: failed to build refresh id for %q: %v", sourceID, err)
		return
	}
	intervalMs := interval
	if intervalMs < 1000 {
		intervalMs = 1000
	}
	message := sourceRefreshMessage{
		Version:       1,
		RefreshID:     refreshID,
		SourceID:      sourceID,
		NewItemsCount: newItemsCount,
		TopTitles:     topTitles,
		UpdatedTime:   updatedTime,
		IntervalMs:    intervalMs,
	}
	payload, err := json.Marshal(message)
	if err != nil {
		log.Printf("newsnowsources: failed to encode refresh event for %q: %v", sourceID, err)
		return
	}
	if err := s.store.Publish(ctx, sourceRefreshChannel, payload); err != nil {
		log.Printf("newsnowsources: failed to publish refresh event for %q: %v", sourceID, err)
	}
}
