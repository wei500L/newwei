package economicdata

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/economicqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// PresetCategoryKeys is the seven-value economic dashboard preset mapping from
// packages/utils/src/economic-refresh-presets.ts.
var PresetCategoryKeys = map[string]string{
	"keyMonitor":       "key-monitor",
	"militaryAlert":    "military-alert",
	"economicAlert":    "economic-alert",
	"economicShort":    "economic-short",
	"economicMedium":   "economic-medium",
	"economicLong":     "economic-long",
	"livelihoodPrices": "livelihood-prices",
}

// TriggerContext carries the request identity used only for preset auditing.
type TriggerContext struct {
	ActorID   string
	OrgID     string
	IPAddress *string
}

// PresetError is a 400 contract error.
type PresetError struct{ Message string }

func (e *PresetError) Error() string { return e.Message }

// TriggerDataFetch queues one manual-fetch job per slug and returns immediately.
// Empty input is a no-op success. Unknown slugs are enqueued; the worker records
// their failure later.
func (s *Service) TriggerDataFetch(ctx context.Context, slugs []string, triggeredByID string) error {
	if s == nil || s.queue == nil {
		return errNoRedis
	}
	traceID := httpx.TraceIDFromContext(ctx)
	if traceID == "" {
		traceID = newTraceID()
	}
	for _, slug := range slugs {
		if _, err := s.queue.AddManual(ctx, economicqueue.JobData{DataItemID: slug, TriggeredByID: triggeredByID, TraceID: traceID}); err != nil {
			return err
		}
	}
	return nil
}

// TriggerDataFetchForPreset selects enabled active slugs for one dashboard
// category, enqueues them, then writes a best-effort audit row.
func (s *Service) TriggerDataFetchForPreset(ctx context.Context, preset string, trigger TriggerContext) error {
	categoryKey, ok := PresetCategoryKeys[preset]
	if !ok {
		return &PresetError{Message: "Unsupported economic refresh preset: " + preset}
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT DISTINCT i.`slug` FROM `EconomicDataFetchConfig` f "+
			"INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId` "+
			"INNER JOIN `EconomicDataItemCategory` ic ON ic.`itemId` = i.`id` "+
			"INNER JOIN `EconomicCategory` c ON c.`id` = ic.`categoryId` "+
			"WHERE f.`isEnabled` = 1 AND i.`isActive` = 1 AND c.`key` = ? ORDER BY i.`slug` ASC", categoryKey)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := map[string]bool{}
	slugs := make([]string, 0)
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return err
		}
		slug = strings.TrimSpace(slug)
		if slug == "" || seen[slug] {
			continue
		}
		seen[slug] = true
		slugs = append(slugs, slug)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.Strings(slugs)
	if len(slugs) == 0 {
		return &PresetError{Message: fmt.Sprintf("No enabled economic data items are configured for refresh preset '%s'.", preset)}
	}
	if err := s.TriggerDataFetch(ctx, slugs, trigger.ActorID); err != nil {
		return err
	}
	if trigger.OrgID != "" {
		metadata := presetAuditMetadata{
			Preset:      preset,
			CategoryKey: categoryKey,
			SlugCount:   len(slugs),
			Slugs:       slugs,
		}
		s.writeAuditLogBestEffort(ctx, trigger.OrgID, trigger.ActorID, "economic_data", "manual_refresh_trigger", metadata, trigger.IPAddress)
	}
	return nil
}

func newTraceID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", int64(1))
	}
	return hex.EncodeToString(buffer)
}
