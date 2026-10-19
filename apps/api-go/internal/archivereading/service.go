package archivereading

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"log"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

const (
	defaultDigestPageSize = 12
	maxDigestPageSize     = 100
)

// PreparationRecord is the narrow status record the producer port returns.
type PreparationRecord struct {
	State        string
	UpdatedAt    time.Time
	ErrorMessage *string
}

// PreparationQueue is the BullMQ producer/status port. The concrete adapter in
// cmd/api wraps archivepreparation.Producer so this package owns no queue keys.
type PreparationQueue interface {
	EnsureDigestCoverage(ctx context.Context, orgID, anchorDate string) error
	EnsureCalendarCoverage(ctx context.Context, orgID, month string) error
	ReadStatus(ctx context.Context, scope string, orgID, scopeValue string) (*PreparationRecord, error)
}

// ModelUsage is one attempt's usage snapshot.
type ModelUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// ModelAttempt is one real logical model attempt for the archive log writer.
type ModelAttempt struct {
	OrgID                     string
	RequestType               string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     ModelUsage
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	MetadataSource            string
	OccurredAt                time.Time
}

// AttemptWriter persists one attempt. Logging is best effort.
type AttemptWriter interface {
	WriteArchiveAttempt(ctx context.Context, attempt ModelAttempt) error
}

// Options wires the archive reading service on the shared resources.
type Options struct {
	DB          *sql.DB
	Mongo       *mongo.Database
	Redis       RedisCache
	Models      *llmembed.Client
	Vector      *itemsreading.ArchiveVectorClient
	Preparation PreparationQueue
	Attempts    AttemptWriter
}

// Service owns the four archive read paths.
type Service struct {
	store          *archiveStore
	classification *classificationStore
	display        *displayStore
	models         *llmembed.Client
	vector         *itemsreading.ArchiveVectorClient
	preparation    PreparationQueue
	attempts       AttemptWriter
	cache          *searchCache
	redis          RedisCache
}

// RedisCache is the narrow shared-cache/metric surface the search path uses.
// A nil implementation keeps every cache read/write best-effort.
type RedisCache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	IncrBy(ctx context.Context, key, field string, delta int64) error
	Expire(ctx context.Context, key string, ttl time.Duration) error
}

// NewService wires the read service; the returned service never starts a
// worker or goroutine.
func NewService(opts Options) *Service {
	return &Service{
		store:          &archiveStore{db: opts.DB},
		classification: &classificationStore{db: opts.DB},
		display:        newDisplayStore(opts.Mongo, opts.DB),
		models:         opts.Models,
		vector:         opts.Vector,
		preparation:    opts.Preparation,
		attempts:       opts.Attempts,
		cache:          newSearchCache(),
		redis:          opts.Redis,
	}
}

// Digest runs archiveDigest.
func (s *Service) Digest(ctx context.Context, orgID string, input DigestInput) (DigestResult, error) {
	anchor := utcDayEnd(input.AnchorDate)
	search := strings.TrimSpace(input.Search)
	pageSize := resolvePageSize(input.PageSize)
	cursorOffsets := resolveCursorOffsets(input.Cursors)
	maxCursorOffset := 0
	for _, offset := range cursorOffsets {
		if offset > maxCursorOffset {
			maxCursorOffset = offset
		}
	}
	if maxCursorOffset > maxBaseScan {
		maxCursorOffset = maxBaseScan
	}
	targetRows := pageSize * len(VerticalOrder) * 6
	if maxCursorOffset+pageSize > targetRows {
		targetRows = maxCursorOffset + pageSize
	}
	if targetRows < 1200 {
		targetRows = 1200
	}
	if targetRows > maxBaseScan {
		targetRows = maxBaseScan
	}

	rows, searchResult, err := s.loadCandidates(ctx, orgID, anchor, search, targetRows)
	if err != nil {
		return DigestResult{}, err
	}
	if search == "" && len(rows) >= maxBaseScan {
		log.Printf("api-go: archive digest scan limit reached org=%s anchor=%s", orgID, anchor.Format(time.RFC3339))
	}

	fresh, err := s.loadFreshClassifications(ctx, orgID, rows)
	if err != nil {
		return DigestResult{}, err
	}
	eligibility := s.display.resolveEligibilityBatch(ctx, orgID, rows)
	pending := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if _, ok := fresh[row.ID]; !ok {
			pending[row.ID] = struct{}{}
		}
		if eligibility[row.ID].NeedsBackfill {
			pending[row.ID] = struct{}{}
		}
	}
	missingCount := len(pending)
	readyCount := len(rows) - missingCount
	if readyCount < 0 {
		readyCount = 0
	}
	var enqueueError string
	if missingCount > 0 {
		if err := s.ensureDigest(ctx, orgID, dateKey(anchor)); err != nil {
			enqueueError = err.Error()
			log.Printf("api-go: archive digest enqueue failed org=%s anchor=%s: %v", orgID, dateKey(anchor), err)
		}
	}

	groups, totalCount := s.projectGroups(rows, fresh, eligibility, input.Region, input.Weights, anchor, search, searchResult, pageSize, cursorOffsets)

	preparation := s.preparationForDigest(ctx, orgID, anchor, readyCount, missingCount, enqueueError)
	return DigestResult{
		AnchorDate:  anchor,
		Region:      input.Region,
		TotalCount:  totalCount,
		Groups:      groups,
		Preparation: preparation,
	}, nil
}

// Calendar runs archiveCalendar. It pages the whole month with 600-row keyset
// batches and never applies the digest scan budget.
func (s *Service) Calendar(ctx context.Context, orgID string, input CalendarInput) ([]CalendarDay, error) {
	start, end, err := monthRange(input.Month)
	if err != nil {
		return nil, err
	}
	buckets := map[string]int{}
	var cursor *Cursor
	hasMissing := false
	for {
		rows, err := s.store.rangeBatch(ctx, orgID, start, end, cursor, calendarScanBatch)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			break
		}
		fresh, err := s.loadFreshClassifications(ctx, orgID, rows)
		if err != nil {
			return nil, err
		}
		eligibility := s.display.resolveEligibilityBatch(ctx, orgID, rows)
		for _, row := range rows {
			classification, ok := fresh[row.ID]
			if !ok {
				hasMissing = true
				continue
			}
			if eligibility[row.ID].NeedsBackfill {
				hasMissing = true
			}
			if !eligibility[row.ID].ShouldDisplay {
				continue
			}
			sortAt := row.SortAt()
			if sortAt.Before(start) || sortAt.After(end) {
				continue
			}
			if input.Region != nil && classification.Result.Region != *input.Region {
				continue
			}
			if input.Vertical != nil && classification.Result.Vertical != *input.Vertical {
				continue
			}
			buckets[dateKey(sortAt)]++
		}
		last := rows[len(rows)-1]
		cursor = &Cursor{ProcessedAt: last.ProcessedAt, ID: last.ID}
		if len(rows) < calendarScanBatch {
			break
		}
	}
	if hasMissing {
		if err := s.ensureCalendar(ctx, orgID, input.Month); err != nil {
			log.Printf("api-go: archive calendar enqueue failed org=%s month=%s: %v", orgID, input.Month, err)
		}
	}
	days := make([]CalendarDay, 0, len(buckets))
	for date, count := range buckets {
		if count > 0 {
			days = append(days, CalendarDay{Date: date, Count: count})
		}
	}
	sortCalendarDays(days)
	return days, nil
}

// Detail runs archiveDetail. A missing, cross-tenant, non-completed or
// display-ineligible article is (nil, nil); a missing cached classification
// keeps the article and returns a null classification.
func (s *Service) Detail(ctx context.Context, orgID, processedArticleID string) (*DetailResult, error) {
	row, err := s.store.detailRow(ctx, orgID, processedArticleID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	eligibility := s.display.resolveEligibilityBatch(ctx, orgID, []*ArchiveRow{row})
	if !eligibility[row.ID].ShouldDisplay {
		return nil, nil
	}
	verified, err := s.loadClassificationWithStale(ctx, orgID, []*ArchiveRow{row})
	if err != nil {
		return nil, err
	}
	var classification *ClassificationDetail
	if cached, ok := verified[row.ID]; ok {
		classification = s.buildClassificationDetail(cached)
	}
	eventID := row.EventID
	var timeline []TimelineEntry
	var related []RelatedArticle
	if eventID != nil && strings.TrimSpace(*eventID) != "" {
		exists, err := s.store.eventExists(ctx, orgID, *eventID)
		if err != nil {
			return nil, err
		}
		if exists {
			timeline, err = s.store.detailTimeline(ctx, orgID, *eventID)
			if err != nil {
				return nil, err
			}
			related, err = s.store.detailRelated(ctx, orgID, *eventID)
			if err != nil {
				return nil, err
			}
		}
	}
	if timeline == nil {
		timeline = []TimelineEntry{}
	}
	if related == nil {
		related = []RelatedArticle{}
	}
	return &DetailResult{
		ProcessedArticleID: row.ID,
		EventID:            eventID,
		Title:              optionalTrimmed(row.Title),
		Summary:            optionalTrimmed(row.Summary),
		FullEntities:       entityNames(row.EntitiesJSON),
		SourceURL:          optionalTrimmed(row.ArticleURL),
		SourceLabel:        optionalTrimmed(row.SourceLabelDisplay()),
		Classification:     classification,
		Timeline:           timeline,
		RelatedArticles:    related,
	}, nil
}

func (s *Service) loadCandidates(ctx context.Context, orgID string, anchor time.Time, search string, targetRows int) ([]*ArchiveRow, searchCandidateResult, error) {
	if search != "" {
		result, err := s.searchCandidates(ctx, orgID, anchor, search)
		if err != nil {
			return nil, searchCandidateResult{}, err
		}
		return result.Rows, result, nil
	}
	rows := make([]*ArchiveRow, 0, targetRows)
	var cursor *Cursor
	for len(rows) < maxBaseScan {
		take := digestScanBatch
		if remaining := maxBaseScan - len(rows); remaining < take {
			take = remaining
		}
		batch, err := s.store.recentBatch(ctx, orgID, anchor, cursor, take)
		if err != nil {
			return nil, searchCandidateResult{}, err
		}
		if len(batch) == 0 {
			break
		}
		rows = append(rows, batch...)
		last := batch[len(batch)-1]
		cursor = &Cursor{ProcessedAt: last.ProcessedAt, ID: last.ID}
		if len(rows) >= targetRows {
			break
		}
	}
	return rows, searchCandidateResult{}, nil
}

// classificationLookups builds the current local rule context and exact cache
// text for every row.
func (s *Service) classificationLookups(rows []*ArchiveRow) map[string]classificationLookup {
	lookups := make(map[string]classificationLookup, len(rows))
	for _, row := range rows {
		source := row.SourceLabelDisplay()
		topics := decodeStringArray(row.TopicsJSON)
		entities := decodeEntityNames(row.EntitiesJSON)
		rule := ClassifyRuleSignals(RuleInput{
			Title: row.Title, Summary: row.Summary, Source: source,
			Topics: topics, Entities: entities, Location: row.Location,
		})
		text := buildClassificationText(classificationTextInput{
			Title: row.Title, Summary: row.Summary, Source: source,
			Topics: topics, Entities: entities, Location: row.Location, Rule: rule,
		})
		lookups[row.ID] = classificationLookup{
			ProcessedArticleID: row.ID,
			Text:               text,
			TextHash:           hashClassificationText(text),
			Rule:               rule,
		}
	}
	return lookups
}

func (s *Service) currentModels(ctx context.Context) (modelSelection, error) {
	selection := modelSelection{}
	if s.models == nil {
		return selection, nil
	}
	embedding, ok, err := s.models.RuntimeEmbeddingModelState(ctx)
	if err != nil {
		return selection, err
	}
	if ok && strings.TrimSpace(embedding) != "" {
		selection.EmbeddingModel = &embedding
	}
	rerank, _, ok, err := s.models.RuntimeRerankProfileState(ctx)
	if err != nil {
		return selection, err
	}
	if ok && strings.TrimSpace(rerank) != "" {
		selection.RerankModel = &rerank
	}
	return selection, nil
}

func (s *Service) loadFreshClassifications(ctx context.Context, orgID string, rows []*ArchiveRow) (map[string]cachedClassification, error) {
	lookups := s.classificationLookups(rows)
	list := make([]classificationLookup, 0, len(lookups))
	for _, lookup := range lookups {
		list = append(list, lookup)
	}
	models, err := s.currentModels(ctx)
	if err != nil {
		return nil, err
	}
	cached, err := s.classification.loadCached(ctx, orgID, list, models)
	if err != nil {
		return nil, err
	}
	fresh := make(map[string]cachedClassification, len(cached))
	for id, entry := range cached {
		if entry.Fresh {
			fresh[id] = entry
		}
	}
	return fresh, nil
}

func (s *Service) loadClassificationWithStale(ctx context.Context, orgID string, rows []*ArchiveRow) (map[string]cachedClassification, error) {
	lookups := s.classificationLookups(rows)
	list := make([]classificationLookup, 0, len(lookups))
	for _, lookup := range lookups {
		list = append(list, lookup)
	}
	models, err := s.currentModels(ctx)
	if err != nil {
		return nil, err
	}
	return s.classification.loadCached(ctx, orgID, list, models)
}

func (s *Service) buildDigestItem(row *ArchiveRow, classification classificationResult, weight int, search string, result searchCandidateResult) DigestItem {
	item := DigestItem{
		ProcessedArticleID: row.ID,
		EventID:            row.EventID,
		Title:              optionalTrimmed(row.Title),
		Summary:            optionalTrimmed(row.Summary),
		CountryLabel:       optionalTrimmed(classification.CountryLabel),
		Region:             classification.Region,
		Vertical:           classification.Vertical,
		Weight:             weight,
		QualityScore:       normalizeQuality(row.QualityScore),
		PublishedAt:        row.PublishedAtDisplay(),
		SortAt:             row.SortAt(),
		SourceLabel:        optionalTrimmed(row.SourceLabelDisplay()),
		SourceURL:          optionalTrimmed(row.ArticleURL),
		EntityTags:         nonNilStrings(classification.EntityTags),
		KeywordHighlights:  keywordHighlights(search, row, classification.EntityTags),
	}
	if score, ok := result.RerankScores[row.ID]; ok {
		value := score
		item.RerankScore = &value
	}
	if score, ok := result.RelevanceScores[row.ID]; ok {
		value := score
		item.RelevanceScore = &value
	}
	if origin, ok := result.Origins[row.ID]; ok {
		value := origin
		item.MatchOrigin = &value
	}
	return item
}

func (s *Service) preparationForDigest(ctx context.Context, orgID string, anchor time.Time, readyCount, missingCount int, enqueueError string) PreparationProjection {
	now := time.Now().UTC()
	if missingCount <= 0 {
		return PreparationProjection{State: PreparationReady, ReadyCount: readyCount, UpdatedAt: now}
	}
	var stored *PreparationRecord
	if s.preparation != nil {
		record, err := s.preparation.ReadStatus(ctx, string(ScopeDigest), orgID, dateKey(anchor))
		if err != nil {
			log.Printf("api-go: archive digest status read failed org=%s: %v", orgID, err)
		} else {
			stored = record
		}
	}
	updatedAt := now
	if stored != nil && !stored.UpdatedAt.IsZero() {
		updatedAt = stored.UpdatedAt
	}
	var storedMessage *string
	storedState := PreparationState("")
	if stored != nil {
		storedState = PreparationStateFromStorage(stored.State)
		if stored.ErrorMessage != nil {
			redacted := adminlogs.RedactSensitiveFields(*stored.ErrorMessage)
			storedMessage = &redacted
		}
	}
	if enqueueError != "" || storedState == PreparationFailed {
		message := enqueueError
		if message == "" && storedMessage != nil {
			message = *storedMessage
		}
		if message == "" && stored != nil && stored.ErrorMessage != nil {
			message = *stored.ErrorMessage
		}
		var projected *string
		if message != "" {
			redacted := adminlogs.RedactSensitiveFields(message)
			projected = &redacted
		}
		return PreparationProjection{State: PreparationFailed, ReadyCount: readyCount, MissingCount: missingCount, UpdatedAt: updatedAt, ErrorMessage: projected}
	}
	if readyCount > 0 {
		return PreparationProjection{State: PreparationPartial, ReadyCount: readyCount, MissingCount: missingCount, UpdatedAt: updatedAt, ErrorMessage: storedMessage}
	}
	state := storedState
	if state == "" {
		state = PreparationQueued
	}
	return PreparationProjection{State: state, ReadyCount: readyCount, MissingCount: missingCount, UpdatedAt: updatedAt, ErrorMessage: storedMessage}
}

const (
	ScopeDigest   = "digest"
	ScopeCalendar = "calendar"
)

func (s *Service) ensureDigest(ctx context.Context, orgID, anchorDate string) error {
	if s.preparation == nil {
		return nil
	}
	return s.preparation.EnsureDigestCoverage(ctx, orgID, anchorDate)
}

func (s *Service) ensureCalendar(ctx context.Context, orgID, month string) error {
	if s.preparation == nil {
		return nil
	}
	return s.preparation.EnsureCalendarCoverage(ctx, orgID, month)
}

func (s *Service) buildClassificationDetail(cached cachedClassification) *ClassificationDetail {
	result := cached.Result
	signals := []string{}
	if signal, ok := cached.Rule.VerticalSignals[result.Vertical]; ok {
		for _, value := range signal.MatchedCountries {
			signals = append(signals, "Country match: "+value)
		}
		for _, value := range signal.MatchedStrongKeywords {
			signals = append(signals, "Strong keyword: "+value)
		}
		for _, value := range signal.MatchedWeakKeywords {
			signals = append(signals, "Keyword: "+value)
		}
		for _, value := range signal.ExcludedKeywords {
			signals = append(signals, "Boundary suppressor: "+value)
		}
		for _, value := range signal.ConflictKeywords {
			signals = append(signals, "Conflict suppressor: "+value)
		}
		if len(signals) > 12 {
			signals = signals[:12]
		}
	}
	entries := make([]ScoreEntry, 0, len(VerticalOrder))
	for _, vertical := range VerticalOrder {
		entries = append(entries, ScoreEntry{
			Vertical:       vertical,
			RuleScore:      result.RuleScores.get(vertical),
			EmbeddingScore: result.EmbeddingScores.get(vertical),
			RerankScore:    result.RerankScores.get(vertical),
			FusedScore:     result.FusedScores.get(vertical),
		})
	}
	staleKeys := make([]string, 0, len(cached.StaleReasons))
	for _, reason := range cached.StaleReasons {
		staleKeys = append(staleKeys, StaleI18n[reason])
	}
	return &ClassificationDetail{
		Region:                result.Region,
		Vertical:              result.Vertical,
		TaxonomyVersion:       result.TaxonomyVersion,
		PipelineVersion:       result.PipelineVersion,
		EmbeddingModel:        result.EmbeddingModel,
		RerankModel:           result.RerankModel,
		DecisionReason:        result.DecisionReason,
		DecisionReasonI18nKey: DecisionI18n[result.DecisionReason],
		IsStale:               !cached.Fresh,
		StaleReasons:          nonNilStaleReasons(cached.StaleReasons),
		StaleReasonI18nKeys:   staleKeys,
		RuleSignals:           signals,
		ScoreEntries:          entries,
	}
}

func nonNilStaleReasons(values []StaleReason) []StaleReason {
	if len(values) == 0 {
		return []StaleReason{}
	}
	return values
}

func resolvePageSize(pageSize int) int {
	if pageSize < 1 {
		return defaultDigestPageSize
	}
	if pageSize > maxDigestPageSize {
		return maxDigestPageSize
	}
	return pageSize
}

func allowedWeightSet(weights []Weight) map[int]bool {
	if len(weights) == 0 {
		return map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}
	}
	set := make(map[int]bool, len(weights))
	for _, weight := range weights {
		if value := WeightValue(weight); value > 0 {
			set[value] = true
		}
	}
	if len(set) == 0 {
		return map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}
	}
	return set
}

func qualityToWeight(score *float64) int {
	if score == nil || !isFinite(*score) {
		return 1
	}
	clamped := clamp01(*score)
	switch {
	case clamped < 0.2:
		return 1
	case clamped < 0.4:
		return 2
	case clamped < 0.6:
		return 3
	case clamped < 0.8:
		return 4
	default:
		return 5
	}
}

func normalizeQuality(value *float64) *float64 {
	if value == nil || !isFinite(*value) {
		return nil
	}
	clamped := clamp01(*value)
	return &clamped
}

func sortDigestItems(items []DigestItem, useRelevance bool) {
	// Stable sorting keeps the JS comparator semantics (relevance, weight,
	// sortAt, id) for equal keys without materializing a second index slice.
	sort.SliceStable(items, func(i, j int) bool {
		return compareDigestItems(items[i], items[j], useRelevance) < 0
	})
}

func compareDigestItems(a, b DigestItem, useRelevance bool) int {
	if useRelevance {
		aScore, bScore := -1.0, -1.0
		if a.RelevanceScore != nil {
			aScore = *a.RelevanceScore
		}
		if b.RelevanceScore != nil {
			bScore = *b.RelevanceScore
		}
		if bScore != aScore {
			if bScore > aScore {
				return 1
			}
			return -1
		}
	}
	if b.Weight != a.Weight {
		if b.Weight > a.Weight {
			return 1
		}
		return -1
	}
	if !b.SortAt.Equal(a.SortAt) {
		if b.SortAt.After(a.SortAt) {
			return 1
		}
		return -1
	}
	return strings.Compare(a.ProcessedArticleID, b.ProcessedArticleID)
}

func sortCalendarDays(days []CalendarDay) {
	sort.Slice(days, func(i, j int) bool { return days[i].Date < days[j].Date })
}

func clampOffset(offset, total int) int {
	if offset < 0 {
		return 0
	}
	if offset > total {
		return total
	}
	return offset
}

// cursorPayload is the base64url JSON cursor body.
type cursorPayload struct {
	Vertical Vertical `json:"v"`
	Offset   int      `json:"o"`
}

func encodeCursor(vertical Vertical, offset int) string {
	body, _ := json.Marshal(cursorPayload{Vertical: vertical, Offset: maxInt(0, offset)})
	return base64.RawURLEncoding.EncodeToString(body)
}

func resolveCursorOffsets(cursors []CursorInput) map[Vertical]int {
	offsets := make(map[Vertical]int, len(cursors))
	for _, cursor := range cursors {
		if verticalIndex(cursor.Vertical) < 0 || cursor.Cursor == nil {
			continue
		}
		offset, ok := decodeCursor(cursor.Vertical, *cursor.Cursor)
		if !ok {
			continue
		}
		offsets[cursor.Vertical] = offset
	}
	return offsets
}

func decodeCursor(vertical Vertical, raw string) (int, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 256 {
		return 0, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(trimmed)
	}
	if err != nil {
		return 0, false
	}
	var payload struct {
		Vertical string `json:"v"`
		Offset   any    `json:"o"`
	}
	if err := json.Unmarshal(decoded, &payload); err != nil || payload.Vertical != string(vertical) {
		return 0, false
	}
	offset, ok := jsNumber(payload.Offset)
	if !ok || offset < 0 {
		return 0, false
	}
	return int(math.Floor(offset)), true
}

// jsNumber mirrors Number(value) for the cursor offset member.
func jsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, isFinite(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil && isFinite(parsed)
	default:
		return 0, false
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func utcDayEnd(value time.Time) time.Time {
	return time.Date(value.UTC().Year(), value.UTC().Month(), value.UTC().Day(), 23, 59, 59, 999000000, time.UTC)
}

func dateKey(value time.Time) string {
	return value.UTC().Format("2006-01-02")
}

var monthPattern = regexp.MustCompile(`^(\d{4})-(\d{2})$`)

func monthRange(month string) (time.Time, time.Time, error) {
	trimmed := strings.TrimSpace(month)
	match := monthPattern.FindStringSubmatch(trimmed)
	if match == nil {
		return time.Time{}, time.Time{}, monthError()
	}
	year, _ := strconv.Atoi(match[1])
	// Date.UTC maps years 0..99 onto 1900..1999, unlike time.Date.
	if year >= 0 && year <= 99 {
		year += 1900
	}
	monthNumber, _ := strconv.Atoi(match[2])
	if monthNumber < 1 || monthNumber > 12 {
		return time.Time{}, time.Time{}, monthError()
	}
	start := time.Date(year, time.Month(monthNumber), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0).Add(-time.Millisecond)
	return start, end, nil
}

func optionalTrimmed(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func keywordHighlights(search string, row *ArchiveRow, entityTags []string) []string {
	normalized := strings.TrimSpace(search)
	if normalized == "" {
		return []string{}
	}
	tokens := make([]string, 0, 8)
	for _, token := range strings.Fields(normalized) {
		if len(token) > 1 {
			tokens = append(tokens, token)
		}
	}
	if len(tokens) == 0 {
		return []string{}
	}
	haystack := strings.ToLower(strings.Join([]string{row.Title, row.Summary, strings.Join(entityTags, "\n")}, "\n"))
	highlights := make([]string, 0, len(tokens))
	seen := make(map[string]struct{}, len(tokens))
	for _, token := range tokens {
		if !strings.Contains(haystack, strings.ToLower(token)) {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		highlights = append(highlights, token)
		if len(highlights) >= 8 {
			break
		}
	}
	if highlights == nil {
		return []string{}
	}
	return highlights
}

func entityNames(raw []byte) []string {
	entities := decodeEntityNames(raw)
	out := make([]string, 0, len(entities))
	seen := make(map[string]struct{}, len(entities))
	for _, entity := range entities {
		name := strings.TrimSpace(entity.Name)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	if out == nil {
		return []string{}
	}
	return out
}

// PreparationStateFromStorage keeps the enum closed when a stored state is
// unknown.
func PreparationStateFromStorage(value string) PreparationState {
	switch PreparationState(strings.TrimSpace(value)) {
	case PreparationIdle, PreparationQueued, PreparationProcessing, PreparationPartial, PreparationReady, PreparationFailed:
		return PreparationState(strings.TrimSpace(value))
	default:
		return ""
	}
}

// projectGroups applies freshness, display, anchor, weight and region filters,
// then sorts and pages the fixed five groups. The digest and the export
// snapshot share this projection so their ordering cannot drift.
func (s *Service) projectGroups(rows []*ArchiveRow, fresh map[string]cachedClassification, eligibility map[string]displayEligibility, region Region, weights []Weight, anchor time.Time, search string, result searchCandidateResult, pageSize int, cursorOffsets map[Vertical]int) ([]VerticalGroup, int) {
	grouped := make(map[Vertical][]DigestItem, len(VerticalOrder))
	allowedWeights := allowedWeightSet(weights)
	useRelevance := search != ""
	for _, row := range rows {
		classification, ok := fresh[row.ID]
		if !ok {
			continue
		}
		if !eligibility[row.ID].ShouldDisplay {
			continue
		}
		sortAt := row.SortAt()
		if sortAt.After(anchor) {
			continue
		}
		weight := qualityToWeight(row.QualityScore)
		if !allowedWeights[weight] {
			continue
		}
		if classification.Result.Region != region {
			continue
		}
		vertical := classification.Result.Vertical
		if verticalIndex(vertical) < 0 {
			continue
		}
		grouped[vertical] = append(grouped[vertical], s.buildDigestItem(row, classification.Result, weight, search, result))
	}

	totalCount := 0
	groups := make([]VerticalGroup, 0, len(VerticalOrder))
	for _, vertical := range VerticalOrder {
		items := grouped[vertical]
		sortDigestItems(items, useRelevance)
		totalCount += len(items)
		offset := clampOffset(cursorOffsets[vertical], len(items))
		end := offset + pageSize
		if end > len(items) {
			end = len(items)
		}
		hasMore := end < len(items)
		var next *string
		if hasMore {
			encoded := encodeCursor(vertical, end)
			next = &encoded
		}
		page := items[offset:end]
		if page == nil {
			page = []DigestItem{}
		}
		groups = append(groups, VerticalGroup{
			Vertical:    vertical,
			DisplayName: VerticalDisplayName[vertical],
			TotalCount:  len(items),
			Items:       page,
			PageInfo:    PageInfo{HasMore: hasMore, NextCursor: next},
		})
	}
	return groups, totalCount
}
