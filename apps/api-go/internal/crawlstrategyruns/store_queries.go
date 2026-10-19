package crawlstrategyruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// This file ports the two scoped lookups trialRunWorkflow performs before it
// creates a run: CrawlStrategyRuntimeService.resolveProfile and
// resolveNewsSource (apps/api/src/modules/crawl/crawl-strategy-runtime.service.ts:1283-1304).
// Both read the row by primary key and compare orgId afterwards, so a
// cross-tenant id returns the same 404 as an absent one.

const profileSelect = `
SELECT id, orgId, name, description, matchHost, executionMode, version, config
FROM CrawlSiteProfile WHERE id = ?`

// resolveProfile returns nil when no profileId was supplied.
func (s *Service) resolveProfile(ctx context.Context, orgID, profileID string) (*profileRow, error) {
	if profileID == "" {
		return nil, nil
	}
	var (
		row         profileRow
		description sql.NullString
		config      []byte
	)
	err := s.db.QueryRowContext(ctx, profileSelect, profileID).Scan(
		&row.ID, &row.OrgID, &row.Name, &description, &row.MatchHost,
		&row.ExecutionMode, &row.Version, &config,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(404, "Crawl site profile not found")
	}
	if err != nil {
		return nil, err
	}
	if row.OrgID != orgID {
		return nil, newStatus(404, "Crawl site profile not found")
	}
	if description.Valid {
		value := description.String
		row.Description = &value
	}
	row.Config = json.RawMessage(config)
	return &row, nil
}

const newsSourceSelect = "SELECT id, orgId, url, name, config FROM NewsSource WHERE id = ?"

// resolveNewsSource returns nil when no newsSourceId was supplied.
func (s *Service) resolveNewsSource(ctx context.Context, orgID, sourceID string) (*newsSourceRow, error) {
	if sourceID == "" {
		return nil, nil
	}
	var (
		row    newsSourceRow
		config []byte
	)
	err := s.db.QueryRowContext(ctx, newsSourceSelect, sourceID).Scan(
		&row.ID, &row.OrgID, &row.URL, &row.Name, &config,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(404, "News source not found")
	}
	if err != nil {
		return nil, err
	}
	if row.OrgID != orgID {
		return nil, newStatus(404, "News source not found")
	}
	row.Config = json.RawMessage(config)
	return &row, nil
}
