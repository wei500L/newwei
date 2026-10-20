package newseventstimeline

import (
	"context"
	"database/sql"
	"time"
)

// rebuildOrg is rebuildOrg: gate on the three settings flags, select the active
// events inside the retention window, rebuild every event's buckets and merge the
// analysis into metadata.timeline.
func (s *Scheduler) rebuildOrg(ctx context.Context, orgID string) error {
	if s.settings == nil {
		return nil
	}
	settings, err := s.settings.Read(ctx, orgID)
	if err != nil {
		return err
	}
	if !settings.Enabled || !settings.IngestionEnabled || !settings.TimelineEnabled {
		return nil
	}
	runtimeSettings := resolveTimelineRuntimeSettings(settings)

	windowDays := settings.BackfillDays
	if settings.LookbackDays > windowDays {
		windowDays = settings.LookbackDays
	}
	now := s.clock()
	since := now.Add(-time.Duration(windowDays) * 24 * time.Hour)
	events, err := s.store.selectEvents(ctx, orgID, since, settings.TimelineMaxEventsPerRun)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}

	// One classification cache per organization run (O3).
	classifications := newClassificationCache(s.store)

	processedEvents := 0
	upserts := 0
	driftWarnings := 0
	for _, event := range events {
		items, err := s.loadEventItems(ctx, orgID, event.ID, windowDays, classifications)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			processedEvents++
			continue
		}

		buckets := groupByDayBucket(items)
		bucketKeys := buckets.sortedKeys()
		bucketEntries := make(map[string]timelineEntryClassification, len(bucketKeys))
		builtEntries := make([]builtTimelineEntry, 0, len(bucketKeys))
		for _, bucketKey := range bucketKeys {
			bucket, ok := buckets.get(bucketKey)
			if !ok || len(bucket.Items) == 0 {
				continue
			}
			entry := buildTimelineEntry(event.ID, bucket.BucketStart, bucket.Items, runtimeSettings)
			builtEntries = append(builtEntries, entry)
			bucketEntries[formatISOMillis(entry.BucketStart)] = entry.Classification
		}

		writeAt := s.clock()
		if err := s.store.upsertTimelineEntries(ctx, orgID, builtEntries, writeAt); err != nil {
			return err
		}
		upserts += len(builtEntries)

		analysis := analyzeTimeline(items, builtEntries, runtimeSettings)
		if analysis.TopicDriftWarning {
			driftWarnings++
			summary := ""
			if analysis.TopicDriftSummary != nil {
				summary = *analysis.TopicDriftSummary
			}
			s.logf("newseventstimeline: topic drift warning orgId=%s eventId=%s summary=%q warnings=%d",
				orgID, event.ID, summary, len(analysis.DriftWarnings))
		}

		// A non-object metadata column has no timeline to merge, which is exactly
		// what NestJS's base = {} branch produces before JSON_SET rebuilds the
		// object.
		existingEntries := map[string]timelineEntryClassification{}
		if event.MetadataIsObject {
			existingEntries = normalizeTimelineEntries(event.MetadataEntries)
		}
		merged := mergeTimelineMetadata(event.ID, existingEntries, bucketEntries, analysis, since, writeAt)
		if err := s.store.writeEventTimeline(ctx, orgID, event.ID, merged, writeAt); err != nil {
			return err
		}
		processedEvents++
	}

	s.logf("newseventstimeline: rebuild completed orgId=%s events=%d upserts=%d driftWarnings=%d",
		orgID, processedEvents, upserts, driftWarnings)
	return nil
}

// loadEventItems mirrors loadEventItems, including the second Date.now() that
// recomputes the retention window for the item query.
func (s *Scheduler) loadEventItems(ctx context.Context, orgID, eventID string, windowDays int, classifications *classificationCache) ([]timelineSourceItem, error) {
	since := s.clock().Add(-time.Duration(windowDays) * 24 * time.Hour)
	rows, err := s.store.selectEventItems(ctx, orgID, eventID, since)
	if err != nil {
		return nil, err
	}
	processedItemIDs := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if !row.ProcessedItemID.Valid {
			continue
		}
		value := row.ProcessedItemID.String
		if normalized := normalizeOptionalString(&value); normalized != nil {
			if _, exists := seen[*normalized]; exists {
				continue
			}
			seen[*normalized] = struct{}{}
			processedItemIDs = append(processedItemIDs, *normalized)
		}
	}
	resolved, err := classifications.resolve(ctx, processedItemIDs)
	if err != nil {
		return nil, err
	}

	items := make([]timelineSourceItem, 0, len(rows))
	for _, row := range rows {
		timestamp := row.ProcessedAt.UTC()
		if row.PublishedAt.Valid {
			timestamp = row.PublishedAt.Time.UTC()
		} else if row.CrawlAt.Valid {
			timestamp = row.CrawlAt.Time.UTC()
		}

		var processedItemID *string
		var classification *processedItemClassification
		if row.ProcessedItemID.Valid {
			processedItemID = normalizeOptionalString(&row.ProcessedItemID.String)
			if processedItemID != nil {
				classification = resolved[*processedItemID]
			}
		}

		legacyCategory := (*string)(nil)
		if classification != nil && classification.LegacyCategory != nil {
			legacyCategory = classification.LegacyCategory
		} else if row.Category.Valid {
			legacyCategory = normalizeLegacyCategory(&row.Category.String)
		}
		categoryPath := (*string)(nil)
		if classification != nil {
			categoryPath = normalizeCategoryPath(classification.CategoryPath)
		}
		if categoryPath == nil && legacyCategory != nil {
			categoryPath = legacyCategory
		}
		var categoryConfidence *float64
		if classification != nil {
			categoryConfidence = normalizeConfidence(classification.CategoryConfidence)
		}

		var qualityScore *float64
		if row.QualityScore.Valid {
			qualityScore = normalizeConfidence(&row.QualityScore.Float64)
		}

		items = append(items, timelineSourceItem{
			ProcessedArticleID: row.ProcessedArticleID,
			ArticleID:          row.ArticleID,
			ProcessedItemID:    processedItemID,
			Timestamp:          timestamp,
			Title:              nullStringPointer(row.Title),
			Summary:            nullStringPointer(row.Summary),
			KeyPoints:          nullJSONValue(row.KeyPoints),
			QualityScore:       qualityScore,
			LegacyCategory:     legacyCategory,
			CategoryPath:       categoryPath,
			CategoryConfidence: categoryConfidence,
		})
	}
	return items, nil
}

func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func nullJSONValue(value []byte) []byte {
	if len(value) == 0 {
		return nil
	}
	out := make([]byte, len(value))
	copy(out, value)
	return out
}
