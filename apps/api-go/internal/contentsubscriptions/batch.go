package contentsubscriptions

import (
	"context"
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

func (s *Service) batchUpsertSubscriptions(ctx context.Context, orgID, userID string, inputs []subscriptionInput) (batchResponse, error) {
	if err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		return s.ensureSubscriptionMigration(ctx, conn, orgID, userID)
	}); err != nil {
		return batchResponse{}, err
	}
	s.ensureFresh(ctx, orgID)
	taxonomy, err := s.loadTaxonomy(ctx, orgID)
	if err != nil {
		return batchResponse{}, err
	}
	normalized := normalizeBatch(inputs, true)
	if len(normalized) == 0 {
		counts, err := s.readCounts(ctx, s.db, orgID, userID)
		if err != nil {
			return batchResponse{}, err
		}
		return newBatchResponse(nil, counts), nil
	}
	resolved, err := s.resolveEntries(ctx, orgID, normalized)
	if err != nil {
		return batchResponse{}, err
	}
	var response batchResponse
	err = s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		var lockErr error
		response, lockErr = s.upsertLocked(ctx, conn, orgID, userID, normalized, resolved, taxonomy)
		return lockErr
	})
	return response, err
}

func (s *Service) upsertLocked(ctx context.Context, q queryer, orgID, userID string, normalized []normalizedEntry, resolved []personalnews.CatalogResolution, taxonomy personalnews.TaxonomyView) (batchResponse, error) {
	existing, err := s.findSubscriptionsByPairs(ctx, q, orgID, userID, normalized)
	if err != nil {
		return batchResponse{}, err
	}
	counts, err := s.readCounts(ctx, q, orgID, userID)
	if err != nil {
		return batchResponse{}, err
	}
	byKey := indexResolutions(resolved)
	results := make([]batchItem, 0, len(normalized))
	toCreate := make([]insertSubscription, 0)
	createEntries := make([]normalizedEntry, 0)
	for _, entry := range normalized {
		key := subscriptionKey(entry.Kind, entry.NormalizedValue)
		if row, ok := existing[key]; ok {
			results = append(results, batchItemFromRow("already_subscribed", row, taxonomy))
			continue
		}
		resolution, ok := byKey[key]
		if !ok {
			resolution = adHocResolution(entry, taxonomy.Version)
		}
		if counts.get(entry.Kind) >= personalnews.LimitPerKind {
			results = append(results, batchItemFromResolution("limit_reached", entry, resolution, taxonomy))
			continue
		}
		row, err := insertionFromResolution(entry, resolution, taxonomy.Version, entry.Source)
		if err != nil {
			return batchResponse{}, err
		}
		toCreate = append(toCreate, row)
		createEntries = append(createEntries, entry)
		counts.add(entry.Kind, 1)
	}
	if len(toCreate) > 0 {
		// 锁覆盖：计数读取 → INSERT IGNORE → 回读。并发的另一个实例
		// 必须等到 RELEASE_LOCK 之后才能再数一次，因此同一种类不会被
		// 两批请求一起冲过 50。已经超过 50 的旧行不在这里删除。
		if err := s.insertSubscriptions(ctx, q, orgID, userID, toCreate, nowMillis(), true); err != nil {
			if !isDuplicateKey(err) {
				return batchResponse{}, err
			}
		}
		created, err := s.findSubscriptionsByPairs(ctx, q, orgID, userID, createEntries)
		if err != nil {
			return batchResponse{}, err
		}
		for _, entry := range normalized {
			key := subscriptionKey(entry.Kind, entry.NormalizedValue)
			if _, already := existing[key]; already {
				continue
			}
			row, ok := created[key]
			if !ok {
				continue
			}
			results = append(results, batchItemFromRow("subscribed", row, taxonomy))
		}
	}
	if err := s.reconcileContentSubscriptionSync(ctx, q, orgID, userID); err != nil {
		return batchResponse{}, err
	}
	refreshed, err := s.readCounts(ctx, q, orgID, userID)
	if err != nil {
		return batchResponse{}, err
	}
	return newBatchResponse(results, refreshed), nil
}

func (s *Service) batchDeleteSubscriptions(ctx context.Context, orgID, userID string, inputs []subscriptionInput) (batchResponse, error) {
	var response batchResponse
	err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureSubscriptionMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		taxonomy, err := s.loadTaxonomy(ctx, orgID)
		if err != nil {
			return err
		}
		normalized := normalizeBatch(inputs, false)
		if len(normalized) == 0 {
			counts, err := s.readCounts(ctx, conn, orgID, userID)
			if err != nil {
				return err
			}
			response = newBatchResponse(nil, counts)
			return nil
		}
		existing, err := s.findSubscriptionsByPairs(ctx, conn, orgID, userID, normalized)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(existing))
		for _, row := range existing {
			ids = append(ids, row.ID)
		}
		if err := s.deleteSubscriptionsByIDs(ctx, conn, orgID, userID, ids); err != nil {
			return err
		}
		results := make([]batchItem, 0, len(normalized))
		for _, entry := range normalized {
			row, ok := existing[subscriptionKey(entry.Kind, entry.NormalizedValue)]
			if ok {
				results = append(results, batchItemFromRow("deleted", row, taxonomy))
				continue
			}
			results = append(results, batchItem{
				Kind:                entry.Kind,
				NormalizedValue:     entry.NormalizedValue,
				DisplayValue:        entry.DisplayValue,
				TaxonomyPath:        nil,
				TaxonomyDisplayName: nil,
				TaxonomyLabels:      []string{},
				Status:              "not_found",
			})
		}
		// 手动监控会在 reconcile 里把刚删掉、但仍被监控拥有的订阅插回去。
		// 每行状态保持 deleted；刷新后的 counts 会计入被插回的行。
		if err := s.reconcileContentSubscriptionSync(ctx, conn, orgID, userID); err != nil {
			return err
		}
		refreshed, err := s.readCounts(ctx, conn, orgID, userID)
		if err != nil {
			return err
		}
		response = newBatchResponse(results, refreshed)
		return nil
	})
	return response, err
}

func normalizeBatch(inputs []subscriptionInput, defaultManual bool) []normalizedEntry {
	entries := make([]normalizedEntry, 0, len(inputs))
	for _, input := range inputs {
		source := input.Source
		if defaultManual && !input.HasSource {
			source = personalnews.SourceManual
		}
		entries = append(entries, normalizedEntry{
			Kind:         input.Kind,
			DisplayValue: input.Value,
			Source:       source,
		})
	}
	return normalizeInputEntries(entries)
}

func newBatchResponse(items []batchItem, counted counts) batchResponse {
	if items == nil {
		items = []batchItem{}
	}
	return batchResponse{
		LimitPerKind: personalnews.LimitPerKind,
		Counts:       counted,
		Items:        items,
	}
}

func batchItemFromRow(status string, row storedSubscription, taxonomy personalnews.TaxonomyView) batchItem {
	path := nullablePath(row.TaxonomyPath.String, row.TaxonomyPath.Valid)
	return batchItem{
		Kind:                row.Kind,
		NormalizedValue:     row.NormalizedValue,
		DisplayValue:        row.DisplayValue,
		TaxonomyPath:        path,
		TaxonomyDisplayName: taxonomyDisplayName(path, taxonomy),
		TaxonomyLabels:      labelsFor(path),
		Status:              status,
	}
}

func batchItemFromResolution(status string, entry normalizedEntry, resolution personalnews.CatalogResolution, taxonomy personalnews.TaxonomyView) batchItem {
	display := resolution.DisplayValue
	if display == "" {
		display = entry.DisplayValue
	}
	return batchItem{
		Kind:                entry.Kind,
		NormalizedValue:     entry.NormalizedValue,
		DisplayValue:        display,
		TaxonomyPath:        resolution.TaxonomyPath,
		TaxonomyDisplayName: taxonomyDisplayName(resolution.TaxonomyPath, taxonomy),
		TaxonomyLabels:      labelsFor(resolution.TaxonomyPath),
		Status:              status,
	}
}

func labelsFor(path *string) []string {
	if path == nil {
		return []string{}
	}
	return taxonomyLabels(*path)
}
