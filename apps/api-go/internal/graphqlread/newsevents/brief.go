package newsevents

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// newsEventBrief serves the news-event detail brief. A matching briefV1 cache
// hit is returned as is; a miss, an explicit forceRefresh, a language change or
// a source-fingerprint change generates synchronously through the model
// gateway. No event, an event of another tenant, or no usable source URL is a
// legal null. Generation failure is never a legal null: a missing key or a
// broken payload is the field internal error Nest produces, and the governance
// 503 keeps its status.
func (s *service) newsEventBrief(ctx contract.Context) (any, error) {
	if s == nil || s.db == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	eventID, _ := contract.StringArg(ctx.Args, "eventId")
	languageArg, _ := contract.StringArg(ctx.Args, "language")
	language := normalizeLanguage(languageArg)
	maxSources := 10
	if value, ok := contract.IntArg(ctx.Args, "maxSources"); ok {
		maxSources = clampInt(value, 3, 20)
	}
	force := false
	if value, ok := boolArg(ctx.Args, "forceRefresh"); ok {
		force = value
	}
	callCtx := s.call(ctx)
	row, err := s.loadEvent(callCtx, ctx.Identity.OrgID, eventID)
	if err != nil || row == nil {
		return nil, err
	}
	items, err := s.loadItems(callCtx, row.ID, 200)
	if err != nil {
		return nil, err
	}
	sources := selectBriefSources(items, maxSources)
	if len(sources) == 0 {
		return nil, nil
	}
	fingerprint := briefFingerprint(language, row.LastAt, sources)
	if !force {
		if cached := readCachedBrief(row.Metadata); cached != nil && cached.Language == language && cached.Fingerprint == fingerprint {
			return cached.model(), nil
		}
	}
	if s.brief == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	// Nest takes generatedAt before the model call and returns it even when
	// the cache write-back fails afterwards.
	generatedAt := s.clock().UTC()
	payload, err := s.generateBrief(callCtx, ctx.Identity.OrgID, row, sources, language)
	if err != nil {
		log.Printf("api-go: news event brief generation failed: %v", err)
		var status *publicportal.StatusError
		if errors.As(err, &status) && status != nil && status.Code == http.StatusServiceUnavailable {
			// Keep the 503 contract; fieldFailure masks the upstream message
			// and only the safe log above carries the original reason.
			return nil, &contract.Failure{Status: http.StatusServiceUnavailable, Message: status.Message}
		}
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	sanitized := sanitizePayload(payload, len(sources))
	if err := s.saveBriefV1(callCtx, ctx.Identity.OrgID, row.ID, language, fingerprint, generatedAt, sources, sanitized); err != nil {
		// A cache write failure must not hide a generated brief; the previous
		// cache entry is left untouched.
		log.Printf("api-go: news event brief cache write failed: %v", err)
	}
	return briefModel(generatedAt, language, sanitized, sources), nil
}

type briefSource struct {
	Index              int
	URL                string
	SourceLabel        *string
	Title              *string
	Summary            *string
	KeyPoints          []string
	PublishedAt        *time.Time
	ProcessedItemID    *string
	ProcessedArticleID *string
	stamp              time.Time
}

func selectBriefSources(items []itemRow, maxSources int) []briefSource {
	type candidate struct {
		briefSource
		key string
	}
	candidates := make([]candidate, 0, len(items))
	for _, item := range items {
		rawURL := strings.TrimSpace(item.URL)
		if rawURL == "" {
			continue
		}
		label := item.SourceLabel
		if label == nil || strings.TrimSpace(*label) == "" {
			label = item.Source
		}
		stamp := time.Time{}
		if item.PublishedAt != nil {
			stamp = *item.PublishedAt
		} else if !item.CrawlAt.IsZero() {
			stamp = item.CrawlAt
		} else if !item.ProcessedAt.IsZero() {
			stamp = item.ProcessedAt
		}
		var published *time.Time
		if item.PublishedAt != nil {
			value := *item.PublishedAt
			published = &value
		}
		candidates = append(candidates, candidate{briefSource: briefSource{
			URL:                rawURL,
			SourceLabel:        cleanString(label),
			Title:              cleanString(item.Title),
			Summary:            cleanString(item.Summary),
			KeyPoints:          normalizeKeyPoints(item.KeyPoints),
			PublishedAt:        published,
			ProcessedItemID:    cleanString(item.ProcessedItemID),
			ProcessedArticleID: cleanString(&item.ProcessedArticleID),
			stamp:              stamp,
		}})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].stamp.After(candidates[j].stamp)
	})
	deduped := make([]candidate, 0, len(candidates))
	seenURL := map[string]struct{}{}
	for _, item := range candidates {
		if _, ok := seenURL[item.URL]; ok {
			continue
		}
		seenURL[item.URL] = struct{}{}
		item.key = briefSourceKey(item.SourceLabel, item.URL)
		deduped = append(deduped, item)
	}
	picked := make([]candidate, 0, maxSources)
	used := map[string]struct{}{}
	for _, item := range deduped {
		if len(picked) >= maxSources {
			break
		}
		if _, ok := used[item.key]; ok {
			continue
		}
		used[item.key] = struct{}{}
		picked = append(picked, item)
	}
	if len(picked) < maxSources {
		have := map[string]struct{}{}
		for _, item := range picked {
			have[item.URL] = struct{}{}
		}
		for _, item := range deduped {
			if len(picked) >= maxSources {
				break
			}
			if _, ok := have[item.URL]; ok {
				continue
			}
			picked = append(picked, item)
		}
	}
	out := make([]briefSource, len(picked))
	for i, item := range picked {
		item.Index = i + 1
		out[i] = item.briefSource
	}
	return out
}

// normalizeKeyPoints mirrors Nest normalizeStringList for ProcessedArticle
// keyPoints: trimmed unique non-empty strings, capped at 20.
func normalizeKeyPoints(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []any
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func briefSourceKey(label *string, rawURL string) string {
	if label != nil {
		trimmed := strings.ToLower(strings.TrimSpace(*label))
		if trimmed != "" {
			return trimmed
		}
	}
	parsed, err := url.Parse(rawURL)
	if err == nil && parsed.Hostname() != "" {
		return strings.ToLower(parsed.Hostname())
	}
	return rawURL
}

func cleanString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

type fingerprintBody struct {
	Version  int                 `json:"version"`
	Language string              `json:"language"`
	LastAt   *string             `json:"lastAt"`
	Sources  []fingerprintSource `json:"sources"`
}

type fingerprintSource struct {
	ProcessedArticleID *string `json:"processedArticleId"`
	ProcessedItemID    *string `json:"processedItemId"`
	URL                string  `json:"url"`
}

func briefFingerprint(language string, lastAt time.Time, sources []briefSource) string {
	last := contract.FormatDateTime(lastAt.UTC())
	body := fingerprintBody{Version: 1, Language: language, LastAt: &last, Sources: make([]fingerprintSource, len(sources))}
	for i, source := range sources {
		body.Sources[i] = fingerprintSource{
			ProcessedArticleID: source.ProcessedArticleID,
			ProcessedItemID:    source.ProcessedItemID,
			URL:                source.URL,
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
	sum := sha256.Sum256([]byte(strings.TrimSuffix(buf.String(), "\n")))
	return hex.EncodeToString(sum[:])
}

func normalizeLanguage(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "zh"
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "zh") {
		return "zh"
	}
	if strings.HasPrefix(lower, "en") {
		return "en"
	}
	if len(utf16.Encode([]rune(lower))) <= 8 {
		return lower
	}
	return "zh"
}

type cachedBrief struct {
	Language    string
	Fingerprint string
	GeneratedAt time.Time
	Payload     briefPayload
	Sources     []NewsEventBriefSourceModel
}

// briefPayload is the model payload and the cached payload. The nullable
// leaves are omitted when nil, matching Nest dropping undefined keys from the
// stored briefV1 document; the point lists always serialize as [].
type briefPayload struct {
	DetailedSummary string           `json:"detailed_summary"`
	Tldr            string           `json:"tldr"`
	KeyPoints       []briefPoint     `json:"key_points"`
	WhyItMatters    []briefPoint     `json:"why_it_matters"`
	LatestUpdate    *briefPoint      `json:"latest_update,omitempty"`
	WhatToWatch     []briefPoint     `json:"what_to_watch"`
	Comparison      *briefComparison `json:"comparison,omitempty"`
	Limitations     *string          `json:"limitations,omitempty"`
}

type briefPoint struct {
	Text      string `json:"text"`
	Citations []int  `json:"citations"`
}

type briefComparison struct {
	Consensus  []briefPoint `json:"consensus"`
	Divergence []briefPoint `json:"divergence"`
}

func readCachedBrief(metadata json.RawMessage) *cachedBrief {
	if len(metadata) == 0 {
		return nil
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(metadata, &root) != nil {
		return nil
	}
	raw := root["briefV1"]
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	var doc struct {
		Version     int             `json:"version"`
		Language    string          `json:"language"`
		Fingerprint string          `json:"fingerprint"`
		GeneratedAt string          `json:"generatedAt"`
		Sources     json.RawMessage `json:"sources"`
		Payload     json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Version != 1 {
		return nil
	}
	language := strings.TrimSpace(doc.Language)
	fingerprint := strings.TrimSpace(doc.Fingerprint)
	generatedRaw := strings.TrimSpace(doc.GeneratedAt)
	if language == "" || fingerprint == "" || generatedRaw == "" || len(doc.Sources) == 0 || len(doc.Payload) == 0 {
		return nil
	}
	var payload briefPayload
	if json.Unmarshal(doc.Payload, &payload) != nil {
		return nil
	}
	if strings.TrimSpace(payload.DetailedSummary) == "" || strings.TrimSpace(payload.Tldr) == "" {
		return nil
	}
	var sources []cachedSource
	if json.Unmarshal(doc.Sources, &sources) != nil {
		return nil
	}
	parsedSources := make([]NewsEventBriefSourceModel, 0, len(sources))
	for _, source := range sources {
		if source.Index < 1 || strings.TrimSpace(source.URL) == "" {
			continue
		}
		parsedSources = append(parsedSources, source.model())
	}
	if len(parsedSources) == 0 {
		return nil
	}
	generatedAt, err := time.Parse(time.RFC3339Nano, generatedRaw)
	if err != nil {
		generatedAt = time.Now().UTC()
	}
	// Nest sanitizes against the count of the sources that survived the cache
	// schema, not the raw array length.
	payload = sanitizePayload(payload, len(parsedSources))
	return &cachedBrief{
		Language:    language,
		Fingerprint: fingerprint,
		GeneratedAt: generatedAt,
		Payload:     payload,
		Sources:     parsedSources,
	}
}

type cachedSource struct {
	Index              int     `json:"index"`
	URL                string  `json:"url"`
	SourceLabel        *string `json:"sourceLabel"`
	Title              *string `json:"title"`
	PublishedAt        *string `json:"publishedAt"`
	ProcessedItemID    *string `json:"processedItemId"`
	ProcessedArticleID *string `json:"processedArticleId"`
}

func (source cachedSource) model() NewsEventBriefSourceModel {
	var published *time.Time
	if source.PublishedAt != nil && strings.TrimSpace(*source.PublishedAt) != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, *source.PublishedAt); err == nil {
			published = &parsed
		}
	}
	return NewsEventBriefSourceModel{
		Index:              source.Index,
		URL:                strings.TrimSpace(source.URL),
		SourceLabel:        cleanString(source.SourceLabel),
		Title:              cleanString(source.Title),
		PublishedAt:        published,
		ProcessedItemID:    cleanString(source.ProcessedItemID),
		ProcessedArticleID: cleanString(source.ProcessedArticleID),
	}
}

func (cached *cachedBrief) model() NewsEventBriefModel {
	return NewsEventBriefModel{
		Version:         1,
		GeneratedAt:     cached.GeneratedAt,
		Language:        cached.Language,
		DetailedSummary: strings.TrimSpace(cached.Payload.DetailedSummary),
		Tldr:            strings.TrimSpace(cached.Payload.Tldr),
		KeyPoints:       mapPoints(cached.Payload.KeyPoints),
		WhyItMatters:    mapPoints(cached.Payload.WhyItMatters),
		LatestUpdate:    mapPointPtr(cached.Payload.LatestUpdate),
		WhatToWatch:     mapPoints(cached.Payload.WhatToWatch),
		Comparison:      mapComparison(cached.Payload.Comparison),
		Limitations:     cached.Payload.Limitations,
		Sources:         cached.Sources,
	}
}

// briefDocument is the NewsEvent.metadata.briefV1 leaf written after a
// successful generation.
type briefDocument struct {
	Version     int            `json:"version"`
	Language    string         `json:"language"`
	Fingerprint string         `json:"fingerprint"`
	GeneratedAt string         `json:"generatedAt"`
	Sources     []cachedSource `json:"sources"`
	Payload     briefPayload   `json:"payload"`
}

// saveBriefV1 writes only the briefV1 leaf with MySQL JSON_SET so the latest
// metadata siblings (timeline and other generators) survive. A non-object or
// null metadata column is treated as an empty object, exactly like Nest's
// mergeMetadata. The UPDATE is scoped to id plus orgId and runs after the
// model call, so no transaction or row lock is held during the network call.
func (s *service) saveBriefV1(ctx context.Context, orgID, eventID, language, fingerprint string, generatedAt time.Time, sources []briefSource, payload briefPayload) error {
	document := briefDocument{
		Version:     1,
		Language:    language,
		Fingerprint: fingerprint,
		GeneratedAt: contract.FormatDateTime(generatedAt),
		Sources:     cacheSources(sources),
		Payload:     payload,
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE NewsEvent
SET metadata = JSON_SET(
      CASE WHEN JSON_TYPE(metadata) = 'OBJECT' THEN metadata ELSE JSON_OBJECT() END,
      '$.briefV1', CAST(? AS JSON)),
    updatedAt = ?
WHERE id = ? AND orgId = ?`,
		string(raw), s.clock().UTC().Truncate(time.Millisecond), eventID, orgID)
	return err
}

func cacheSources(sources []briefSource) []cachedSource {
	out := make([]cachedSource, 0, len(sources))
	for _, source := range sources {
		var published *string
		if source.PublishedAt != nil {
			text := contract.FormatDateTime(*source.PublishedAt)
			published = &text
		}
		out = append(out, cachedSource{
			Index:              source.Index,
			URL:                source.URL,
			SourceLabel:        source.SourceLabel,
			Title:              source.Title,
			PublishedAt:        published,
			ProcessedItemID:    source.ProcessedItemID,
			ProcessedArticleID: source.ProcessedArticleID,
		})
	}
	return out
}

func briefModel(generatedAt time.Time, language string, payload briefPayload, sources []briefSource) NewsEventBriefModel {
	return NewsEventBriefModel{
		Version:         1,
		GeneratedAt:     generatedAt,
		Language:        language,
		DetailedSummary: strings.TrimSpace(payload.DetailedSummary),
		Tldr:            strings.TrimSpace(payload.Tldr),
		KeyPoints:       mapPoints(payload.KeyPoints),
		WhyItMatters:    mapPoints(payload.WhyItMatters),
		LatestUpdate:    mapPointPtr(payload.LatestUpdate),
		WhatToWatch:     mapPoints(payload.WhatToWatch),
		Comparison:      mapComparison(payload.Comparison),
		Limitations:     payload.Limitations,
		Sources:         sourceModels(sources),
	}
}

func sourceModels(sources []briefSource) []NewsEventBriefSourceModel {
	out := make([]NewsEventBriefSourceModel, 0, len(sources))
	for _, source := range sources {
		out = append(out, NewsEventBriefSourceModel{
			Index:              source.Index,
			URL:                source.URL,
			SourceLabel:        source.SourceLabel,
			Title:              source.Title,
			PublishedAt:        source.PublishedAt,
			ProcessedItemID:    source.ProcessedItemID,
			ProcessedArticleID: source.ProcessedArticleID,
		})
	}
	return out
}

// sanitizePayload mirrors Nest sanitizePayload: trim the text leaves, drop
// empty list points, sanitize citations, and keep latest_update as a trimmed
// point even when the trimmed text is empty.
func sanitizePayload(payload briefPayload, maxSources int) briefPayload {
	payload.DetailedSummary = strings.TrimSpace(payload.DetailedSummary)
	payload.Tldr = strings.TrimSpace(payload.Tldr)
	payload.KeyPoints = sanitizePoints(payload.KeyPoints, maxSources)
	payload.WhyItMatters = sanitizePoints(payload.WhyItMatters, maxSources)
	if payload.LatestUpdate != nil {
		point := sanitizePoint(*payload.LatestUpdate, maxSources)
		payload.LatestUpdate = &point
	}
	payload.WhatToWatch = sanitizePoints(payload.WhatToWatch, maxSources)
	if payload.Comparison != nil {
		payload.Comparison = &briefComparison{
			Consensus:  sanitizePoints(payload.Comparison.Consensus, maxSources),
			Divergence: sanitizePoints(payload.Comparison.Divergence, maxSources),
		}
	}
	return payload
}

func sanitizePoints(points []briefPoint, maxSources int) []briefPoint {
	out := make([]briefPoint, 0, len(points))
	for _, point := range points {
		next := sanitizePoint(point, maxSources)
		if next.Text == "" {
			continue
		}
		out = append(out, next)
	}
	return out
}

// sanitizePoint mirrors Nest sanitizeCitations order: filter the valid
// indexes, take the first 12, then dedupe and sort ascending.
func sanitizePoint(point briefPoint, maxSources int) briefPoint {
	filtered := make([]int, 0, len(point.Citations))
	for _, value := range point.Citations {
		if value < 1 || value > maxSources {
			continue
		}
		if len(filtered) >= 12 {
			break
		}
		filtered = append(filtered, value)
	}
	seen := make(map[int]struct{}, len(filtered))
	citations := make([]int, 0, len(filtered))
	for _, value := range filtered {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		citations = append(citations, value)
	}
	sort.Ints(citations)
	return briefPoint{Text: strings.TrimSpace(point.Text), Citations: citations}
}

func mapPoints(points []briefPoint) []NewsEventBriefPointModel {
	out := make([]NewsEventBriefPointModel, 0, len(points))
	for _, point := range points {
		citations := point.Citations
		if citations == nil {
			citations = []int{}
		}
		out = append(out, NewsEventBriefPointModel{Text: point.Text, Citations: citations})
	}
	return out
}

// mapPointPtr keeps a non-nil latest_update even when the trimmed text is
// empty: Nest does not turn a blank trimmed point into null.
func mapPointPtr(point *briefPoint) *NewsEventBriefPointModel {
	if point == nil {
		return nil
	}
	mapped := mapPoints([]briefPoint{*point})
	return &mapped[0]
}

func mapComparison(value *briefComparison) *NewsEventBriefComparisonModel {
	if value == nil {
		return nil
	}
	return &NewsEventBriefComparisonModel{
		Consensus:  mapPoints(value.Consensus),
		Divergence: mapPoints(value.Divergence),
	}
}
