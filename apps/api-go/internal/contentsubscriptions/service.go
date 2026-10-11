package contentsubscriptions

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// Service 持有订阅行、遗留迁移和态势监控归属对账。
// 目录生成只通过构造时注入的 CatalogAPI，不直接读目录表。
type Service struct {
	db      *sql.DB
	catalog personalnews.CatalogAPI
}

func NewService(db *sql.DB, catalog personalnews.CatalogAPI) *Service {
	return &Service{db: db, catalog: catalog}
}

var _ personalnews.SubscriptionAPI = (*Service)(nil)

func (s *Service) listUserSubscriptions(ctx context.Context, orgID, userID string) (listResponse, error) {
	if err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		return s.ensureSubscriptionMigration(ctx, conn, orgID, userID)
	}); err != nil {
		return listResponse{}, err
	}
	taxonomy, err := s.loadTaxonomy(ctx, orgID)
	if err != nil {
		return listResponse{}, err
	}
	var ownership map[string]ownershipEntry
	var rows []storedSubscription
	err = s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		var lockErr error
		ownership, lockErr = s.buildSubscriptionOwnershipMap(ctx, conn, orgID, userID)
		if lockErr != nil {
			return lockErr
		}
		rows, lockErr = s.listSubscriptions(ctx, conn, orgID, userID)
		return lockErr
	})
	if err != nil {
		return listResponse{}, err
	}
	counted := emptyCounts()
	items := make([]any, 0, len(rows))
	for _, row := range rows {
		counted.add(row.Kind, 1)
		item := mapSubscription(row, taxonomy)
		if entry, ok := ownership[subscriptionKey(row.Kind, row.NormalizedValue)]; ok {
			items = append(items, ownedSubscriptionItem{
				subscriptionItem:   item,
				OwnerMonitorIds:    copyStrings(entry.OwnerMonitorIds),
				OwnerMonitorNames:  copyStrings(entry.OwnerMonitorNames),
				ManualMonitorOwned: entry.ManualMonitorOwned,
				SystemSyncOwned:    entry.SystemSyncOwned,
			})
			continue
		}
		items = append(items, item)
	}
	return listResponse{
		LimitPerKind:    personalnews.LimitPerKind,
		Counts:          counted,
		Items:           items,
		TaxonomyVersion: taxonomy.Version,
	}, nil
}

func mapSubscription(row storedSubscription, taxonomy personalnews.TaxonomyView) subscriptionItem {
	path := nullablePath(row.TaxonomyPath.String, row.TaxonomyPath.Valid)
	labels := []string{}
	if path != nil && *path != "" {
		labels = taxonomyLabels(*path)
	}
	return subscriptionItem{
		ID:                  row.ID,
		Kind:                row.Kind,
		NormalizedValue:     row.NormalizedValue,
		DisplayValue:        row.DisplayValue,
		TaxonomyPath:        path,
		TaxonomyDisplayName: taxonomyDisplayName(path, taxonomy),
		TaxonomyLabels:      labels,
		Source:              row.Source,
		Metadata:            metadataJSON(row.Metadata),
		CreatedAt:           formatJSISO(row.CreatedAt),
		UpdatedAt:           formatJSISO(row.UpdatedAt),
	}
}

func formatJSISO(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func copyStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

func (s *Service) listCatalog(ctx context.Context, orgID string, query catalogQuery) ([]byte, error) {
	s.ensureFresh(ctx, orgID)
	if s.catalog == nil {
		return nil, errors.New("content subscription catalog is not configured")
	}
	kind := ""
	if query.KindSet {
		kind = query.Kind
	}
	text := ""
	if query.QuerySet {
		text = query.Query
	}
	taxonomyPath := ""
	if query.TaxonomySet {
		taxonomyPath = query.TaxonomyPath
	}
	return s.catalog.List(ctx, orgID, kind, text, taxonomyPath, normalizeCatalogLimit(query.Limit))
}

func (s *Service) listRecommendations(ctx context.Context, orgID, userID string, limit int, behavior personalnews.BehaviorAPI) ([]byte, error) {
	if err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		return s.ensureSubscriptionMigration(ctx, conn, orgID, userID)
	}); err != nil {
		return nil, err
	}
	s.ensureFresh(ctx, orgID)
	if behavior == nil {
		return nil, errors.New("personalization behavior is not configured")
	}
	profile, err := behavior.GetPersonalizationProfile(ctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.subscriptionKeys(ctx, s.db, orgID, userID)
	if err != nil {
		return nil, err
	}
	subscribed := make([]personalnews.SubscriptionKey, 0, len(rows))
	for _, row := range rows {
		subscribed = append(subscribed, personalnews.SubscriptionKey{Kind: row.Kind, NormalizedValue: row.Normalized})
	}
	if s.catalog == nil {
		return nil, errors.New("content subscription catalog is not configured")
	}
	return s.catalog.Recommend(ctx, orgID, limit, subscribed, profile)
}

func (s *Service) lookupCatalog(ctx context.Context, orgID string, inputs []subscriptionInput) ([]byte, error) {
	s.ensureFresh(ctx, orgID)
	if s.catalog == nil {
		return nil, errors.New("content subscription catalog is not configured")
	}
	entries := make([]personalnews.EntryInput, 0, len(inputs))
	for _, input := range inputs {
		entry := personalnews.EntryInput{Kind: input.Kind, Value: input.Value}
		if input.HasSource {
			entry.Source = input.Source
		}
		entries = append(entries, entry)
	}
	return s.catalog.Lookup(ctx, orgID, entries)
}

func (s *Service) listRelatedTopics(ctx context.Context, orgID, userID, topic string, limit int) ([]byte, error) {
	if err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		return s.ensureSubscriptionMigration(ctx, conn, orgID, userID)
	}); err != nil {
		return nil, err
	}
	s.ensureFresh(ctx, orgID)
	topics, err := s.topicValues(ctx, s.db, orgID, userID)
	if err != nil {
		return nil, err
	}
	if topics == nil {
		topics = []string{}
	}
	if s.catalog == nil {
		return nil, errors.New("content subscription catalog is not configured")
	}
	return s.catalog.RelatedTopics(ctx, orgID, topic, limit, topics)
}

func (s *Service) ensureFresh(ctx context.Context, orgID string) {
	if s == nil || s.catalog == nil {
		log.Printf("content subscriptions: catalog refresh skipped")
		return
	}
	if err := s.catalog.EnsureFresh(ctx, orgID); err != nil {
		log.Printf("content subscriptions: catalog refresh failed: %v", err)
	}
}

func (s *Service) loadTaxonomy(ctx context.Context, orgID string) (personalnews.TaxonomyView, error) {
	if s == nil || s.catalog == nil {
		return personalnews.TaxonomyView{}, errors.New("content subscription catalog is not configured")
	}
	view, err := s.catalog.LoadTaxonomy(ctx, orgID)
	if err != nil {
		return personalnews.TaxonomyView{}, err
	}
	if view.ByPath == nil {
		view.ByPath = map[string]personalnews.TaxonomyNode{}
	}
	return view, nil
}

func (s *Service) resolveEntries(ctx context.Context, orgID string, entries []normalizedEntry) ([]personalnews.CatalogResolution, error) {
	if s == nil || s.catalog == nil {
		return nil, errors.New("content subscription catalog is not configured")
	}
	inputs := make([]personalnews.EntryInput, 0, len(entries))
	for _, entry := range entries {
		inputs = append(inputs, personalnews.EntryInput{
			Kind:            entry.Kind,
			Value:           entry.DisplayValue,
			NormalizedValue: entry.NormalizedValue,
			DisplayValue:    entry.DisplayValue,
			Source:          entry.Source,
		})
	}
	return s.catalog.Resolve(ctx, orgID, inputs)
}
