package realtimesignals

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// Keyword spike and Polymarket leads. The keyword extractor, the two-hour versus
// seven-day baseline and the ProcessedArticleTermHourly coverage check are ports
// of RealtimeKeywordPolymarketService; the Polymarket event list is global and is
// fetched once per round (O1), while the price comparison and the per-organization
// price cache stay per organization.

var topicSplitPattern = regexp.MustCompile(`[^a-z0-9]+`)

// processedArticleTermRow is one groupBy row with the sum alias Prisma returns.
type processedArticleTermRow struct {
	Term         string
	Source       string
	ArticleCount float64
}

// processedArticleRow is the fallback projection.
type processedArticleRow struct {
	Title   string
	Summary string
	Source  string
	Topics  jsonRawMessage
}

// coverageCache is the cached coverage-start probe.
type coverageCache struct {
	BucketStart *string `json:"bucketStart"`
}

// processedArticleFallback is loadKeywordSpikeFallbackCounts.
type processedArticleFallback struct {
	RecentCounts         *termCounts
	BaselineCounts       map[string]float64
	RecentArticleCount   float64
	BaselineArticleCount float64
}

// termCounts keeps the map plus the term order rows arrived in, because the
// spike list is only sorted by multiplier (a stable sort), so ties keep the
// original order like the NestJS Map iteration.
type termCounts struct {
	entries map[string]*termCountEntry
	order   []string
}

func newTermCounts() *termCounts {
	return &termCounts{entries: make(map[string]*termCountEntry)}
}

func (c *termCounts) entry(term string) *termCountEntry {
	entry, exists := c.entries[term]
	if exists {
		return entry
	}
	entry = &termCountEntry{}
	c.entries[term] = entry
	c.order = append(c.order, term)
	return entry
}

// termCountEntry is one term's recent count plus its distinct sources.
type termCountEntry struct {
	Count   float64
	Sources []string
}

func (e *termCountEntry) addSource(source string) {
	for _, existing := range e.Sources {
		if existing == source {
			return
		}
	}
	e.Sources = append(e.Sources, source)
}

// fetchKeywordSpikeSignal mirrors fetchKeywordSpikeSignal.
func (s *Service) fetchKeywordSpikeSignal(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime) ([]FetchResult, error) {
	nowMs := s.clockMillis()
	recentStart := time.UnixMilli(nowMs - 2*60*60*1000).UTC()
	baselineStart := time.UnixMilli(nowMs - 7*24*60*60*1000).UTC()
	coverageStart, err := s.processedArticleTermCoverageStart(ctx, orgID)
	if err != nil {
		return nil, err
	}
	hasCoverage := coverageStart != nil && !coverageStart.After(baselineStart)

	var recentRows []processedArticleTermRow
	var baselineRows []processedArticleTermRow
	var fallback *processedArticleFallback
	if hasCoverage {
		if recentRows, err = s.recentTermRows(ctx, orgID, recentStart); err != nil {
			return nil, err
		}
		if baselineRows, err = s.baselineTermRows(ctx, orgID, baselineStart, recentStart); err != nil {
			return nil, err
		}
	} else {
		fallback, err = s.loadKeywordSpikeFallbackCounts(ctx, orgID, recentStart, baselineStart)
		if err != nil {
			return nil, err
		}
	}
	resolvedFallback := fallback
	if resolvedFallback == nil && len(recentRows) == 0 && len(baselineRows) == 0 {
		resolvedFallback, err = s.loadKeywordSpikeFallbackCounts(ctx, orgID, recentStart, baselineStart)
		if err != nil {
			return nil, err
		}
	}

	var recentCounts *termCounts
	var baselineCounts map[string]float64
	if resolvedFallback != nil {
		recentCounts = resolvedFallback.RecentCounts
		baselineCounts = resolvedFallback.BaselineCounts
	} else {
		recentCounts = buildRecentTermCountsFromBuckets(recentRows)
		baselineCounts = buildBaselineTermCountsFromBuckets(baselineRows)
	}

	minCount := math.Max(1, float64(runtime.Thresholds.KeywordSpikeMinCount))
	requiredMultiplier := math.Max(1, runtime.Thresholds.KeywordSpikeMultiplier)
	const recentHours = 2.0
	const baselineHours = 7 * 24.0

	spikes := make([]KeywordSpike, 0)
	for _, term := range recentCounts.order {
		entry := recentCounts.entries[term]
		if entry.Count < minCount || len(entry.Sources) < 2 {
			continue
		}
		baselineCount := baselineCounts[term]
		baselineExpected := baselineCount / baselineHours * recentHours
		safeBaseline := baselineExpected
		if safeBaseline <= 0 {
			safeBaseline = 1
		}
		multiplier := entry.Count / safeBaseline
		if multiplier < requiredMultiplier {
			continue
		}
		confidence := math.Min(0.95, 0.4+multiplier/10)
		spikes = append(spikes, KeywordSpike{
			ID:          "keyword:" + term,
			Term:        term,
			Count:       entry.Count,
			Baseline:    jsFixedNumber(baselineExpected, 3),
			Multiplier:  jsFixedNumber(multiplier, 3),
			SourceCount: float64(len(entry.Sources)),
			Confidence:  jsFixedNumber(confidence, 3),
		})
	}
	sort.SliceStable(spikes, func(left, right int) bool {
		return spikes[right].Multiplier < spikes[left].Multiplier
	})
	topSpikes := spikes
	if len(topSpikes) > 10 {
		topSpikes = topSpikes[:10]
	}

	recentArticleCount := 0.0
	baselineArticleCount := 0.0
	if resolvedFallback != nil {
		recentArticleCount = resolvedFallback.RecentArticleCount
		baselineArticleCount = resolvedFallback.BaselineArticleCount
	} else {
		for _, row := range recentRows {
			recentArticleCount += row.ArticleCount
		}
		for _, row := range baselineRows {
			baselineArticleCount += row.ArticleCount
		}
	}
	return []FetchResult{{
		MetricSlug: metricKeywordSpike,
		Value:      float64(len(topSpikes)),
		Context: &keywordSpikeContext{
			Source:               "internal",
			RecentArticleCount:   recentArticleCount,
			BaselineArticleCount: baselineArticleCount,
			Spikes:               topSpikes,
		},
	}}, nil
}

// processedArticleTermCoverageStart mirrors
// getProcessedArticleTermCoverageStart, including the cache.wrap behavior where a
// null result is re-loaded every time.
func (s *Service) processedArticleTermCoverageStart(ctx context.Context, orgID string) (*time.Time, error) {
	key := processedTermCoverageKey + orgID
	cached, err := rediscache.Wrap[coverageCache](ctx, s.store.redis, key,
		processedTermCoverageTTL*time.Second, rediscache.WrapOptions{},
		func(value coverageCache) bool { return value.BucketStart != nil && *value.BucketStart != "" },
		func(ctx context.Context) (coverageCache, error) {
			if s.store.db == nil {
				return coverageCache{}, errNoDatabase
			}
			var bucket time.Time
			err := s.store.db.QueryRowContext(ctx,
				"SELECT bucketStart FROM ProcessedArticleTermHourly WHERE orgId = ? ORDER BY bucketStart ASC LIMIT 1",
				orgID).Scan(&bucket)
			if err == sql.ErrNoRows {
				return coverageCache{BucketStart: nil}, nil
			}
			if err != nil {
				return coverageCache{}, err
			}
			formatted := toIsoTimestampFromTime(bucket)
			return coverageCache{BucketStart: &formatted}, nil
		})
	if err != nil {
		return nil, err
	}
	if cached.BucketStart == nil || *cached.BucketStart == "" {
		return nil, nil
	}
	parsed, ok := parseJSTimeMillis(*cached.BucketStart)
	if !ok {
		return nil, nil
	}
	value := time.UnixMilli(parsed).UTC()
	return &value, nil
}

func (s *Service) recentTermRows(ctx context.Context, orgID string, since time.Time) ([]processedArticleTermRow, error) {
	rows, err := s.store.db.QueryContext(ctx,
		"SELECT term, source, SUM(articleCount) FROM ProcessedArticleTermHourly "+
			"WHERE orgId = ? AND bucketStart >= ? GROUP BY term, source", orgID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]processedArticleTermRow, 0)
	for rows.Next() {
		var row processedArticleTermRow
		if err := rows.Scan(&row.Term, &row.Source, &row.ArticleCount); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Service) baselineTermRows(ctx context.Context, orgID string, since, before time.Time) ([]processedArticleTermRow, error) {
	rows, err := s.store.db.QueryContext(ctx,
		"SELECT term, SUM(articleCount) FROM ProcessedArticleTermHourly "+
			"WHERE orgId = ? AND bucketStart >= ? AND bucketStart < ? GROUP BY term", orgID, since, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]processedArticleTermRow, 0)
	for rows.Next() {
		var row processedArticleTermRow
		if err := rows.Scan(&row.Term, &row.ArticleCount); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// buildRecentTermCountsFromBuckets mirrors buildRecentTermCountsFromBuckets.
func buildRecentTermCountsFromBuckets(rows []processedArticleTermRow) *termCounts {
	recent := newTermCounts()
	for _, row := range rows {
		term := jsTrim(row.Term)
		if term == "" {
			continue
		}
		source := jsTrim(row.Source)
		if source == "" {
			source = "unknown"
		}
		entry := recent.entry(term)
		entry.Count += row.ArticleCount
		entry.addSource(source)
	}
	return recent
}

// buildBaselineTermCountsFromBuckets mirrors buildBaselineTermCountsFromBuckets.
func buildBaselineTermCountsFromBuckets(rows []processedArticleTermRow) map[string]float64 {
	baseline := make(map[string]float64, len(rows))
	for _, row := range rows {
		term := jsTrim(row.Term)
		if term == "" {
			continue
		}
		baseline[term] += row.ArticleCount
	}
	return baseline
}

// loadKeywordSpikeFallbackCounts mirrors loadKeywordSpikeFallbackCounts.
func (s *Service) loadKeywordSpikeFallbackCounts(ctx context.Context, orgID string, recentStart, baselineStart time.Time) (*processedArticleFallback, error) {
	recentArticles, err := s.processedArticlesSince(ctx, orgID, recentStart, nil, 1500)
	if err != nil {
		return nil, err
	}
	baselineArticles, err := s.processedArticlesSince(ctx, orgID, baselineStart, &recentStart, 5000)
	if err != nil {
		return nil, err
	}
	recentCounts := newTermCounts()
	baselineCounts := make(map[string]float64)
	for _, article := range recentArticles {
		source := normalizeProcessedArticleSource(article.Source)
		for _, term := range extractProcessedArticleTerms(article) {
			entry := recentCounts.entry(term)
			entry.Count++
			entry.addSource(source)
		}
	}
	for _, article := range baselineArticles {
		for _, term := range extractProcessedArticleTerms(article) {
			baselineCounts[term]++
		}
	}
	return &processedArticleFallback{
		RecentCounts:         recentCounts,
		BaselineCounts:       baselineCounts,
		RecentArticleCount:   float64(len(recentArticles)),
		BaselineArticleCount: float64(len(baselineArticles)),
	}, nil
}

// processedArticlesSince reads the fallback projection. before is exclusive.
func (s *Service) processedArticlesSince(ctx context.Context, orgID string, since time.Time, before *time.Time, limit int) ([]processedArticleRow, error) {
	query := "SELECT title, summary, source, topics FROM ProcessedArticle " +
		"WHERE status = 'completed' AND orgId = ? AND processedAt >= ?"
	args := []any{orgID, since}
	if before != nil {
		query += " AND processedAt < ?"
		args = append(args, *before)
	}
	query += " ORDER BY processedAt DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.store.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]processedArticleRow, 0)
	for rows.Next() {
		var title, summary, source sql.NullString
		var topics []byte
		if err := rows.Scan(&title, &summary, &source, &topics); err != nil {
			return nil, err
		}
		row := processedArticleRow{Title: title.String, Summary: summary.String, Source: source.String}
		if len(topics) > 0 {
			row.Topics = jsonRawMessage(topics)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// normalizeProcessedArticleSource mirrors normalizeProcessedArticleSource.
func normalizeProcessedArticleSource(value string) string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return "unknown"
	}
	return strings.ToLower(trimmed)
}

// extractProcessedArticleTerms mirrors extractProcessedArticleTerms.
func extractProcessedArticleTerms(article processedArticleRow) []string {
	terms := make([]string, 0)
	seen := make(map[string]struct{})
	pushTokens := func(text string) {
		if text == "" {
			return
		}
		for _, token := range topicSplitPattern.Split(strings.ToLower(text), -1) {
			normalized := jsTrim(token)
			if len(normalized) < 4 {
				continue
			}
			if _, stop := simpleStopwords[normalized]; stop {
				continue
			}
			if _, exists := seen[normalized]; exists {
				continue
			}
			seen[normalized] = struct{}{}
			terms = append(terms, normalized)
		}
	}
	pushTokens(article.Title)
	pushTokens(article.Summary)
	for _, topic := range readArray(article.Topics) {
		if text, ok := decodeJSONString(topic); ok {
			pushTokens(text)
			continue
		}
		if !isJSONObject(topic) {
			continue
		}
		var record struct {
			Name  jsonRawMessage `json:"name"`
			Label jsonRawMessage `json:"label"`
		}
		if decodeJSONPayload(topic, &record) != nil {
			continue
		}
		pushTokens(normalizeStringRaw(record.Name))
		pushTokens(normalizeStringRaw(record.Label))
	}
	return terms
}

// fetchPolymarketLeadsSignal mirrors fetchPolymarketLeadsSignal. The events list
// is shared per round (O1); the price cache is per organization.
func (s *Service) fetchPolymarketLeadsSignal(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) ([]FetchResult, error) {
	proxyURL := normalizeURL(runtime.Polymarket.ProxyURL, "")
	baseURL := proxyURL
	if baseURL == "" {
		baseURL = polymarketDefaultURL
	}
	events, err := round.polymarketEvents(ctx, s, runtime, baseURL)
	if err != nil {
		return nil, err
	}
	previousPrices, err := s.readPolymarketPrices(ctx, orgID)
	if err != nil {
		return nil, err
	}
	limit := len(events)
	if limit > 60 {
		limit = 60
	}
	nextPrices := make([]polymarketPrice, 0, limit)
	leads := make([]PredictionLead, 0)
	for _, entry := range events[:limit] {
		var record polymarketEventPayload
		if !isJSONObject(entry) || decodeJSONPayload(entry, &record) != nil {
			continue
		}
		title := normalizeStringRaw(firstRaw(record.Title, record.Name))
		if title == "" {
			continue
		}
		eventID := normalizeStringRaw(record.ID)
		if eventID == "" {
			eventID = title
		}
		active := polymarketEventActive(record.Active, record.Closed)
		if !active {
			continue
		}
		if volume, ok := toFiniteNumber(firstRaw(record.Volume, record.VolumeNum, record.Liquidity)); ok && volume < 1000 {
			continue
		}
		probability, ok := resolvePolymarketYesPrice(record)
		if !ok {
			continue
		}
		nextPrices = append(nextPrices, polymarketPrice{EventID: eventID, Price: probability})
		previous, hasPrevious := previousPrices[eventID]
		shift := 0.0
		if hasPrevious {
			shift = math.Abs(probability - previous)
		}
		if shift < runtime.Thresholds.PredictionShiftThreshold {
			continue
		}
		topicTokens := extractTopicTokens(title)
		newsActivity, err := s.countNewsActivity(ctx, orgID, topicTokens)
		if err != nil {
			return nil, err
		}
		if float64(newsActivity) >= float64(runtime.Thresholds.PredictionNewsActivityThreshold) {
			continue
		}
		confidence := math.Min(0.9, 0.5+shift/20)
		leads = append(leads, PredictionLead{
			ID: eventID, Title: title, Shift: jsFixedNumber(shift, 3),
			NewsActivity: float64(newsActivity), Confidence: jsFixedNumber(confidence, 3),
		})
	}
	sort.SliceStable(leads, func(left, right int) bool {
		return leads[right].Shift < leads[left].Shift
	})
	topLeads := leads
	if len(topLeads) > 20 {
		topLeads = topLeads[:20]
	}
	if err := s.writePolymarketPrices(ctx, orgID, nextPrices); err != nil {
		return nil, err
	}
	source := "gamma-api"
	if proxyURL != "" {
		source = "proxy"
	}
	return []FetchResult{{
		MetricSlug: metricPolymarketLeads,
		Value:      float64(len(topLeads)),
		Context:    &polymarketContext{Source: source, Leads: topLeads},
	}}, nil
}

// polymarketEventPayload is one gamma-api event.
type polymarketEventPayload struct {
	ID          jsonRawMessage `json:"id"`
	Title       jsonRawMessage `json:"title"`
	Name        jsonRawMessage `json:"name"`
	Active      jsonRawMessage `json:"active"`
	Closed      jsonRawMessage `json:"closed"`
	Volume      jsonRawMessage `json:"volume"`
	VolumeNum   jsonRawMessage `json:"volumeNum"`
	Liquidity   jsonRawMessage `json:"liquidity"`
	Markets     jsonRawMessage `json:"markets"`
	YesPrice    jsonRawMessage `json:"yesPrice"`
	Price       jsonRawMessage `json:"price"`
	LastTrade   jsonRawMessage `json:"lastTradePrice"`
	Probability jsonRawMessage `json:"probability"`
}

// polymarketMarketPayload is one markets[] entry.
type polymarketMarketPayload struct {
	YesPrice     jsonRawMessage `json:"yesPrice"`
	OutcomePrice jsonRawMessage `json:"outcomePrice"`
	LastTrade    jsonRawMessage `json:"lastTradePrice"`
}

// resolvePolymarketYesPrice mirrors resolvePolymarketYesPrice. The current Gamma
// API does not expose yesPrice on a market; the alias chain is kept unchanged
// because Q1 only asked for a recorded conclusion, not a parsing change.
func resolvePolymarketYesPrice(event polymarketEventPayload) (float64, bool) {
	for _, market := range readArray(event.Markets) {
		var record polymarketMarketPayload
		if !isJSONObject(market) || decodeJSONPayload(market, &record) != nil {
			continue
		}
		price, ok := toFiniteNumber(firstRaw(record.YesPrice, record.OutcomePrice, record.LastTrade))
		if !ok {
			continue
		}
		if price <= 1 {
			return price * 100, true
		}
		return price, true
	}
	direct, ok := toFiniteNumber(firstRaw(event.YesPrice, event.Price, event.LastTrade, event.Probability))
	if !ok {
		return 0, false
	}
	if direct <= 1 {
		return direct * 100, true
	}
	return direct, true
}

// countNewsActivity mirrors countNewsActivity.
func (s *Service) countNewsActivity(ctx context.Context, orgID string, tokens []string) (int, error) {
	if len(tokens) == 0 {
		return 0, nil
	}
	since := time.UnixMilli(s.clockMillis() - 24*60*60*1000).UTC()
	searchTokens := tokens
	if len(searchTokens) > 3 {
		searchTokens = searchTokens[:3]
	}
	coverageStart, err := s.processedArticleTermCoverageStart(ctx, orgID)
	if err != nil {
		return 0, err
	}
	hasCoverage := coverageStart != nil && !coverageStart.After(since)
	if !hasCoverage {
		return s.countNewsActivityFallback(ctx, orgID, searchTokens, since)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(searchTokens)), ",")
	args := make([]any, 0, len(searchTokens)+2)
	args = append(args, orgID, since)
	for _, token := range searchTokens {
		args = append(args, token)
	}
	rows, err := s.store.db.QueryContext(ctx,
		"SELECT term, SUM(articleCount) FROM ProcessedArticleTermHourly "+
			"WHERE orgId = ? AND bucketStart >= ? AND term IN ("+placeholders+") GROUP BY term", args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	maxCount := 0
	for rows.Next() {
		var term string
		var count float64
		if err := rows.Scan(&term, &count); err != nil {
			return 0, err
		}
		if int(math.Round(count)) > maxCount {
			maxCount = int(math.Round(count))
		}
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if maxCount > 0 {
		return maxCount, nil
	}
	return s.countNewsActivityFallback(ctx, orgID, searchTokens, since)
}

// countNewsActivityFallback mirrors countNewsActivityFallback.
func (s *Service) countNewsActivityFallback(ctx context.Context, orgID string, searchTokens []string, since time.Time) (int, error) {
	total := 0
	for _, token := range searchTokens {
		pattern := "%" + token + "%"
		var count int
		err := s.store.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM ProcessedArticle WHERE status = 'completed' AND orgId = ? AND processedAt >= ? "+
				"AND (title LIKE ? OR summary LIKE ?)", orgID, since, pattern, pattern).Scan(&count)
		if err != nil {
			return 0, err
		}
		if count > total {
			total = count
		}
	}
	return total, nil
}

// extractTopicTokens mirrors extractTopicTokens.
func extractTopicTokens(title string) []string {
	tokens := topicSplitPattern.Split(strings.ToLower(title), -1)
	out := make([]string, 0, len(tokens))
	for _, token := range tokens {
		normalized := jsTrim(token)
		if len(normalized) < 4 {
			continue
		}
		if _, stop := simpleStopwords[normalized]; stop {
			continue
		}
		out = append(out, normalized)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

// polymarketPrice is one event price to store.
type polymarketPrice struct {
	EventID string
	Price   float64
}

// readPolymarketPrices reads the per-organization price map. The document is an
// externally keyed cache (event id -> percent price), so its keys are dynamic by
// design; the values stay typed as numbers.
func (s *Service) readPolymarketPrices(ctx context.Context, orgID string) (map[string]float64, error) {
	prices, found, err := rediscache.GetJSON[map[string]float64](ctx, s.store.redis, polymarketPricesKeyFmt+orgID)
	if err != nil || !found {
		return map[string]float64{}, err
	}
	if prices == nil {
		return map[string]float64{}, nil
	}
	return prices, nil
}

// writePolymarketPrices writes the price map in insertion order. Go's map encoder
// sorts keys; the NestJS record keeps event order, so the payload is written with
// an explicit encoder to stay byte-comparable.
func (s *Service) writePolymarketPrices(ctx context.Context, orgID string, prices []polymarketPrice) error {
	unique := make([]polymarketPrice, 0, len(prices))
	positions := make(map[string]int, len(prices))
	for _, entry := range prices {
		if position, exists := positions[entry.EventID]; exists {
			unique[position] = entry
			continue
		}
		positions[entry.EventID] = len(unique)
		unique = append(unique, entry)
	}
	var payload bytes.Buffer
	payload.WriteByte('{')
	for index, entry := range unique {
		if index > 0 {
			payload.WriteByte(',')
		}
		key, err := json.Marshal(entry.EventID)
		if err != nil {
			return err
		}
		payload.Write(key)
		payload.WriteByte(':')
		value, err := json.Marshal(entry.Price)
		if err != nil {
			return err
		}
		payload.Write(value)
	}
	payload.WriteByte('}')
	return s.store.redis.Set(ctx, polymarketPricesKeyFmt+orgID, payload.Bytes(),
		time.Duration(polymarketPricesTTL)*time.Second).Err()
}

// polymarketEventActive mirrors `record.active !== false && record.closed !==
// true`. Only a real JSON boolean participates: the string "false" is truthy in
// JavaScript and therefore keeps the event active.
func polymarketEventActive(active, closed jsonRawMessage) bool {
	return !jsonFalse(active) && !jsonTrue(closed)
}

// jsonFalse reports whether the raw member is the boolean false. `!== false`
// treats any other value (including "false" and null) as active.
func jsonFalse(raw jsonRawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("false"))
}

func jsonTrue(raw jsonRawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("true"))
}
