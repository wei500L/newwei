package situationsignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const (
	insightsSnapshotFreshKey = "situation-monitor:external-snapshot:gdelt:fresh:v1"
	insightsSnapshotStaleKey = "situation-monitor:external-snapshot:gdelt:stale:v1"
	insightsSnapshotScope    = "gdelt_global"
	insightsSnapshotVariant  = "default"
	insightsSnapshotFreshTTL = 20 * 60
	insightsSnapshotStaleTTL = 24 * 60 * 60
)

type snapshotCategoryState struct {
	Status             string  `json:"status"`
	ArticleCount       int     `json:"articleCount"`
	ContentGeneratedAt *string `json:"contentGeneratedAt"`
	ReasonCode         string  `json:"reasonCode,omitempty"`
}

type snapshotCategoryStates struct {
	Politics snapshotCategoryState `json:"politics"`
	Tech     snapshotCategoryState `json:"tech"`
	Finance  snapshotCategoryState `json:"finance"`
	Gov      snapshotCategoryState `json:"gov"`
	AI       snapshotCategoryState `json:"ai"`
	Intel    snapshotCategoryState `json:"intel"`
}

type snapshotCategoryStateRaw struct {
	Status             string          `json:"status"`
	ArticleCount       json.RawMessage `json:"articleCount"`
	ContentGeneratedAt json.RawMessage `json:"contentGeneratedAt"`
	ReasonCode         json.RawMessage `json:"reasonCode"`
}

type snapshotWarning struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Detail   string `json:"detail,omitempty"`
}

type snapshotDiagnostics struct {
	RequestedCategories int                 `json:"requestedCategories"`
	FetchedCategories   []analysis.Category `json:"fetchedCategories"`
	ReusedCategories    []analysis.Category `json:"reusedCategories"`
	FailedCategories    []analysis.Category `json:"failedCategories"`
	TotalHeadlines      int                 `json:"totalHeadlines"`
}

type snapshotPayload struct {
	Source              string                       `json:"source"`
	Scope               string                       `json:"scope"`
	VariantKey          string                       `json:"variantKey"`
	Status              string                       `json:"status"`
	GeneratedAt         string                       `json:"generatedAt"`
	ExpiresAt           string                       `json:"expiresAt"`
	Partial             bool                         `json:"partial"`
	Warnings            []snapshotWarning            `json:"warnings"`
	Diagnostics         snapshotDiagnostics          `json:"diagnostics"`
	CategoryStates      snapshotCategoryStates       `json:"categoryStates"`
	HeadlinesByCategory analysis.HeadlinesByCategory `json:"headlinesByCategory"`
}

type snapshotReadResult struct {
	Payload *snapshotPayload
	Stale   bool
}

type snapshotRaw struct {
	Source              json.RawMessage                `json:"source"`
	Scope               json.RawMessage                `json:"scope"`
	VariantKey          json.RawMessage                `json:"variantKey"`
	Status              string                         `json:"status"`
	GeneratedAt         string                         `json:"generatedAt"`
	ExpiresAt           string                         `json:"expiresAt"`
	Partial             bool                           `json:"partial"`
	Warnings            []json.RawMessage              `json:"warnings"`
	Diagnostics         snapshotDiagnosticsRaw         `json:"diagnostics"`
	CategoryStates      snapshotCategoryStatesRaw      `json:"categoryStates"`
	HeadlinesByCategory snapshotHeadlinesByCategoryRaw `json:"headlinesByCategory"`
}

type snapshotHeadlinesByCategoryRaw struct {
	Politics []json.RawMessage `json:"politics"`
	Tech     []json.RawMessage `json:"tech"`
	Finance  []json.RawMessage `json:"finance"`
	Gov      []json.RawMessage `json:"gov"`
	AI       []json.RawMessage `json:"ai"`
	Intel    []json.RawMessage `json:"intel"`
}

type snapshotCategoryStatesRaw struct {
	Politics snapshotCategoryStateRaw `json:"politics"`
	Tech     snapshotCategoryStateRaw `json:"tech"`
	Finance  snapshotCategoryStateRaw `json:"finance"`
	Gov      snapshotCategoryStateRaw `json:"gov"`
	AI       snapshotCategoryStateRaw `json:"ai"`
	Intel    snapshotCategoryStateRaw `json:"intel"`
}

type snapshotDiagnosticsRaw struct {
	RequestedCategories json.RawMessage `json:"requestedCategories"`
	FetchedCategories   []string        `json:"fetchedCategories"`
	ReusedCategories    []string        `json:"reusedCategories"`
	FailedCategories    []string        `json:"failedCategories"`
	TotalHeadlines      json.RawMessage `json:"totalHeadlines"`
}

// readExternalSnapshot mirrors SituationMonitorExternalSnapshotService.readSnapshot
// with includeDatabase=true. It never rebuilds or calls GDELT.
func (s *insightsService) readExternalSnapshot(ctx context.Context) (snapshotReadResult, error) {
	if raw, found, err := s.cache.get(ctx, insightsSnapshotFreshKey); err != nil {
		return snapshotReadResult{}, err
	} else if found {
		if payload := normalizeSnapshotPayload([]byte(raw)); payload != nil {
			return snapshotReadResult{Payload: payload, Stale: snapshotExpired(payload.ExpiresAt, s.now())}, nil
		}
	}
	if raw, found, err := s.cache.get(ctx, insightsSnapshotStaleKey); err != nil {
		return snapshotReadResult{}, err
	} else if found {
		if payload := normalizeSnapshotPayload([]byte(raw)); payload != nil {
			return snapshotReadResult{Payload: payload, Stale: snapshotExpired(payload.ExpiresAt, s.now())}, nil
		}
	}
	if s.db == nil {
		return snapshotReadResult{}, nil
	}
	var rawPayload []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT payload FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ? ORDER BY generatedAt DESC, createdAt DESC LIMIT 1",
		insightsSnapshotScope, insightsSnapshotVariant).Scan(&rawPayload)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshotReadResult{}, nil
	}
	if err != nil {
		return snapshotReadResult{}, err
	}
	payload := normalizeSnapshotPayload(rawPayload)
	if payload == nil {
		return snapshotReadResult{}, nil
	}
	if err := s.restoreSnapshotCaches(ctx, payload); err != nil {
		return snapshotReadResult{}, err
	}
	return snapshotReadResult{Payload: payload, Stale: snapshotExpired(payload.ExpiresAt, s.now())}, nil
}

func (s *insightsService) restoreSnapshotCaches(ctx context.Context, payload *snapshotPayload) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	expired := snapshotExpired(payload.ExpiresAt, s.now())
	if !expired {
		if err := s.cache.set(ctx, insightsSnapshotFreshKey, encoded, insightsSnapshotFreshTTL*time.Second); err != nil {
			return err
		}
	}
	return s.cache.set(ctx, insightsSnapshotStaleKey, encoded, insightsSnapshotStaleTTL*time.Second)
}

func normalizeSnapshotPayload(raw []byte) *snapshotPayload {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	var source snapshotRaw
	if err := json.Unmarshal(raw, &source); err != nil {
		return nil
	}
	if source.GeneratedAt == "" || source.ExpiresAt == "" {
		return nil
	}
	payload := &snapshotPayload{
		Source:      "scheduler",
		Scope:       insightsSnapshotScope,
		VariantKey:  insightsSnapshotVariant,
		GeneratedAt: source.GeneratedAt,
		ExpiresAt:   source.ExpiresAt,
		Partial:     source.Partial,
	}
	switch source.Status {
	case "failed":
		payload.Status = "failed"
	case "partial":
		payload.Status = "partial"
	default:
		payload.Status = "completed"
	}
	for _, rawWarning := range source.Warnings {
		var warning snapshotWarning
		if err := json.Unmarshal(rawWarning, &warning); err != nil {
			continue
		}
		payload.Warnings = append(payload.Warnings, warning)
	}
	payload.Diagnostics = normalizeSnapshotDiagnostics(source.Diagnostics)
	payload.HeadlinesByCategory = normalizeSnapshotHeadlines(source.HeadlinesByCategory)
	payload.CategoryStates = normalizeSnapshotCategoryStates(source.CategoryStates, payload.HeadlinesByCategory, payload.Diagnostics, payload.GeneratedAt)
	if payload.Warnings == nil {
		payload.Warnings = []snapshotWarning{}
	}
	return payload
}

func normalizeSnapshotHeadlines(raw snapshotHeadlinesByCategoryRaw) analysis.HeadlinesByCategory {
	var out analysis.HeadlinesByCategory
	categories := []struct {
		category analysis.Category
		values   []json.RawMessage
	}{
		{analysis.CategoryPolitics, raw.Politics},
		{analysis.CategoryTech, raw.Tech},
		{analysis.CategoryFinance, raw.Finance},
		{analysis.CategoryGov, raw.Gov},
		{analysis.CategoryAI, raw.AI},
		{analysis.CategoryIntel, raw.Intel},
	}
	for _, entry := range categories {
		bucket := out.Bucket(entry.category)
		if bucket == nil {
			continue
		}
		items := make([]analysis.Headline, 0, len(entry.values))
		for _, rawHeadline := range entry.values {
			var headline analysis.Headline
			if err := json.Unmarshal(rawHeadline, &headline); err != nil {
				continue
			}
			headline.Category = entry.category
			items = append(items, headline)
		}
		*bucket = items
	}
	return out
}

func normalizeSnapshotDiagnostics(raw snapshotDiagnosticsRaw) snapshotDiagnostics {
	out := snapshotDiagnostics{
		RequestedCategories: len(analysis.Categories),
		FetchedCategories:   normalizeSnapshotCategories(raw.FetchedCategories),
		ReusedCategories:    normalizeSnapshotCategories(raw.ReusedCategories),
		FailedCategories:    normalizeSnapshotCategories(raw.FailedCategories),
	}
	if value, ok := insightsRawJSONNumber(raw.RequestedCategories); ok {
		out.RequestedCategories = int(value)
	}
	if value, ok := insightsRawJSONNumber(raw.TotalHeadlines); ok {
		out.TotalHeadlines = int(value)
	}
	return out
}

func normalizeSnapshotCategories(values []string) []analysis.Category {
	out := make([]analysis.Category, 0, len(values))
	for _, value := range values {
		category := analysis.Category(value)
		for _, candidate := range analysis.Categories {
			if candidate == category {
				out = append(out, category)
				break
			}
		}
	}
	return out
}

func normalizeSnapshotCategoryStates(raw snapshotCategoryStatesRaw, headlines analysis.HeadlinesByCategory, diagnostics snapshotDiagnostics, generatedAt string) snapshotCategoryStates {
	var out snapshotCategoryStates
	entries := []struct {
		category analysis.Category
		state    snapshotCategoryStateRaw
	}{
		{analysis.CategoryPolitics, raw.Politics},
		{analysis.CategoryTech, raw.Tech},
		{analysis.CategoryFinance, raw.Finance},
		{analysis.CategoryGov, raw.Gov},
		{analysis.CategoryAI, raw.AI},
		{analysis.CategoryIntel, raw.Intel},
	}
	for _, entry := range entries {
		bucket := headlines.Bucket(entry.category)
		count := 0
		if bucket != nil {
			count = len(*bucket)
		}
		status := entry.state.Status
		if status != "reused" && status != "empty" && status != "fresh" {
			if count > 0 {
				status = "fresh"
				for _, reused := range diagnostics.ReusedCategories {
					if reused == entry.category {
						status = "reused"
						break
					}
				}
			} else {
				status = "empty"
			}
		}
		articleCount := count
		if value, ok := insightsRawJSONNumber(entry.state.ArticleCount); ok {
			articleCount = int(value)
			if articleCount < 0 {
				articleCount = 0
			}
		}
		var contentGeneratedAt *string
		if status != "empty" {
			value := generatedAt
			if text, ok := insightsRawJSONString(entry.state.ContentGeneratedAt); ok && text != "" {
				value = text
			}
			contentGeneratedAt = &value
		}
		reasonCode := ""
		if text, ok := insightsRawJSONString(entry.state.ReasonCode); ok {
			reasonCode = strings.TrimSpace(text)
		}
		state := snapshotCategoryState{Status: status, ArticleCount: articleCount, ContentGeneratedAt: contentGeneratedAt, ReasonCode: reasonCode}
		switch entry.category {
		case analysis.CategoryPolitics:
			out.Politics = state
		case analysis.CategoryTech:
			out.Tech = state
		case analysis.CategoryFinance:
			out.Finance = state
		case analysis.CategoryGov:
			out.Gov = state
		case analysis.CategoryAI:
			out.AI = state
		case analysis.CategoryIntel:
			out.Intel = state
		}
	}
	return out
}

func insightsRawJSONString(value json.RawMessage) (string, bool) {
	if len(value) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return "", false
	}
	return text, true
}

func insightsRawJSONNumber(value json.RawMessage) (float64, bool) {
	if len(value) == 0 {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(value, &number); err != nil {
		return 0, false
	}
	return number, true
}

func snapshotExpired(expiresAt string, now time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return true
	}
	return !parsed.After(now)
}

// mergeSnapshotHeadlinesByCategory mirrors the core merge, including the
// timestamp floor, placeholder rejection and the per-category link set.
func mergeSnapshotHeadlinesByCategory(byCategory *analysis.HeadlinesByCategory, snapshot *snapshotPayload, since time.Time, maxPerCategory int) {
	if byCategory == nil || snapshot == nil {
		return
	}
	sinceMS := since.UnixMilli()
	for _, category := range analysis.Categories {
		bucket := byCategory.Bucket(category)
		if bucket == nil {
			continue
		}
		links := map[string]bool{}
		for _, headline := range *bucket {
			links[headline.Link] = true
		}
		sourceBucket := snapshot.HeadlinesByCategory.Bucket(category)
		if sourceBucket == nil {
			continue
		}
		for _, headline := range *sourceBucket {
			if headline.Timestamp < sinceMS {
				continue
			}
			title := strings.TrimSpace(headline.Title)
			link := strings.TrimSpace(headline.Link)
			if title == "" || insightsIsPlaceholderTitle(title) || link == "" || links[link] {
				continue
			}
			if len(*bucket) >= maxPerCategory {
				continue
			}
			links[link] = true
			headline.Title = title
			headline.Link = link
			headline.Category = category
			*bucket = append(*bucket, headline)
		}
	}
}

func createExternalSnapshotInfo(snapshot *snapshotPayload, stale bool) externalSnapshotInfo {
	var categories externalSnapshotCategories
	if snapshot != nil {
		categories = externalSnapshotCategories{
			Politics: snapshotInfoState(snapshot.CategoryStates.Politics),
			Tech:     snapshotInfoState(snapshot.CategoryStates.Tech),
			Finance:  snapshotInfoState(snapshot.CategoryStates.Finance),
			Gov:      snapshotInfoState(snapshot.CategoryStates.Gov),
			AI:       snapshotInfoState(snapshot.CategoryStates.AI),
			Intel:    snapshotInfoState(snapshot.CategoryStates.Intel),
		}
	} else {
		empty := externalSnapshotCategoryState{Status: "empty", ArticleCount: 0, ContentGeneratedAt: nil}
		categories = externalSnapshotCategories{Politics: empty, Tech: empty, Finance: empty, Gov: empty, AI: empty, Intel: empty}
	}
	available := 0
	warnings := make([]insightsWarning, 0)
	status := "idle"
	partial := false
	var generatedAt, expiresAt *string
	if snapshot != nil {
		if snapshot.Status == "failed" || snapshot.Status == "partial" || snapshot.Status == "completed" {
			status = snapshot.Status
		} else {
			status = "completed"
		}
		partial = snapshot.Partial
		generatedAt = stringPointer(snapshot.GeneratedAt)
		expiresAt = stringPointer(snapshot.ExpiresAt)
		for _, category := range analysis.Categories {
			bucket := snapshot.HeadlinesByCategory.Bucket(category)
			if bucket != nil && len(*bucket) > 0 {
				available++
			}
		}
		for _, warning := range snapshot.Warnings {
			warnings = append(warnings, insightsWarning{
				Code: warning.Code, Source: "gdelt", Severity: insightSeverity(warning.Severity), Message: warning.Message, Detail: warning.Detail,
			})
		}
	}
	return externalSnapshotInfo{
		Source: "scheduler", Status: status, Stale: stale, Partial: partial,
		GeneratedAt: generatedAt, ExpiresAt: expiresAt, AvailableCategoryCount: available,
		Categories: categories, Warnings: warnings,
	}
}

func snapshotInfoState(state snapshotCategoryState) externalSnapshotCategoryState {
	return externalSnapshotCategoryState{
		Status: state.Status, ArticleCount: state.ArticleCount,
		ContentGeneratedAt: state.ContentGeneratedAt, ReasonCode: state.ReasonCode,
	}
}

func insightSeverity(value string) string {
	switch value {
	case "info", "warning", "error":
		return value
	default:
		return "warning"
	}
}

func stringPointer(value string) *string {
	copied := value
	return &copied
}
