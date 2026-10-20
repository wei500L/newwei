package classificationrssops

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"math/rand"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Pipeline and queue literals shared with the NestJS aggregation filters.
const (
	pipelineStatusCompleted = "completed"
	classifyQueue           = "news_pipeline"
	classifyStage           = "classify"
	categoryGateQueue       = "news_events"
	categoryGateStage       = "category_gate"
	categoryPrefixUnknown   = "unknown"
)

// summaryRequest is the typed input of GET summary.
type summaryRequest struct {
	OrgID          string
	Window         QualityWindow
	SourceID       *string
	CategoryPrefix *string
}

// sourceItemsRequest is the typed input of GET sources/:sourceId/items.
type sourceItemsRequest struct {
	OrgID         string
	SourceID      string
	Window        QualityWindow
	MaxConfidence *float64
	Limit         *int
	Cursor        *string
}

// reviewQueueRequest is the typed input of GET reviews/queue.
type reviewQueueRequest struct {
	OrgID          string
	Window         QualityWindow
	OnlyUnreviewed bool
	Limit          *int
	MaxConfidence  *float64
}

// reviewDecisionRequest is the typed input of POST reviews/:reviewId/decision.
type reviewDecisionRequest struct {
	OrgID                 string
	ActorID               string
	ReviewID              string
	Status                ReviewDecisionStatus
	CorrectedCategoryPath *string
	Note                  *string
	QuickTags             []string
}

// batchReviewDecisionRequest is the typed input of POST reviews/batch.
type batchReviewDecisionRequest struct {
	OrgID                 string
	ActorID               string
	ReviewIDs             []string
	Status                ReviewDecisionStatus
	CorrectedCategoryPath *string
	Note                  *string
	QuickTags             []string
}

// samplingRequest is the typed input of POST sampling/query.
type samplingRequest struct {
	OrgID           string
	ActorID         string
	Window          QualityWindow
	SourceType      *ClassifiedSourceType
	CategoryPrefix  *string
	SourceIDs       []string
	ConfidenceBands []ConfidenceBand
	Methods         []string
	PerStratum      *int
}

// annotationEntry is one annotated sample item.
type annotationEntry struct {
	ProcessedItemID   string
	HumanCategoryPath string
	Note              *string
	QuickTags         []string
}

// annotationsRequest is the typed input of POST sampling/annotations.
type annotationsRequest struct {
	OrgID       string
	ActorID     string
	SampleID    string
	Annotations []annotationEntry
}

// reportJobRequest is the typed input of GET reports/:jobId.
type reportJobRequest struct {
	OrgID string
	JobID string
}

// ClassificationSummary mirrors getSummary: the Redis-cached summary payload.
func (s *Service) ClassificationSummary(ctx context.Context, request summaryRequest) (json.RawMessage, error) {
	sourceKey := "all"
	if request.SourceID != nil {
		sourceKey = *request.SourceID
	}
	categoryKey := "all"
	if request.CategoryPrefix != nil {
		categoryKey = *request.CategoryPrefix
	}
	cacheKey := summaryCachePrefix + request.OrgID + ":" + string(request.Window) + ":" + sourceKey + ":" + categoryKey
	return s.store.cacheWrapJSON(ctx, cacheKey, summaryCacheTTLSeconds, cacheOptions{
		lockTTL:    2 * time.Second,
		renewEvery: time.Second,
		retryDelay: 50 * time.Millisecond,
		maxWait:    3 * time.Second,
	}, func() (json.RawMessage, error) {
		summary, err := s.buildSummary(ctx, request)
		if err != nil {
			return nil, err
		}
		return json.Marshal(summary)
	})
}

// buildSummary mirrors the private buildSummary helper.
func (s *Service) buildSummary(ctx context.Context, request summaryRequest) (classificationQualitySummary, error) {
	settings := s.qualitySettingsFor(ctx, request.OrgID)
	from, to, bucketMinutes := resolveWindow(request.Window)
	policy := s.sourcePolicyFor(ctx, request.OrgID)

	normalizedCategoryPrefix := normalizePath(derefString(request.CategoryPrefix))
	var categoryPrefixRegex *string
	if normalizedCategoryPrefix != nil {
		pattern := buildCategoryPrefixRegex(*normalizedCategoryPrefix)
		categoryPrefixRegex = &pattern
	}

	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return classificationQualitySummary{}, err
	}
	filter := processedItemsFilter(request.OrgID, from, to, request.SourceID, categoryPrefixRegex)
	totalMatchedItems, err := collection.CountDocuments(ctx, filter)
	if err != nil {
		return classificationQualitySummary{}, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "sourceId", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "result.source", Value: 1},
			{Key: "result.category_path", Value: 1},
			{Key: "result.category_confidence", Value: 1},
			{Key: "result.category_method", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(summaryItemsLimit))
	if err != nil {
		return classificationQualitySummary{}, err
	}
	var documents []processedItemDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return classificationQualitySummary{}, err
	}

	documentSourceIDs := make([]string, 0, len(documents))
	for _, document := range documents {
		if sourceID := rawString(document.SourceID); sourceID != nil {
			documentSourceIDs = append(documentSourceIDs, *sourceID)
		}
	}
	sourceMap, err := s.loadSourceMap(ctx, request.OrgID, documentSourceIDs)
	if err != nil {
		return classificationQualitySummary{}, err
	}

	methodCounters := map[string]int{"llm_embedding_rerank": 0, "rule_fallback": 0}
	confidenceValues := make([]float64, 0, len(documents))
	type trendBucket struct {
		total int
		low   int
		sum   float64
	}
	type sourceBucket struct {
		total int
		low   int
		sum   float64
	}
	trendBuckets := make(map[int64]*trendBucket)
	trendOrder := make([]int64, 0, len(documents))
	lowBySource := make(map[string]*sourceBucket)
	lowSourceOrder := make([]string, 0, len(documents))
	sourceCategory := make(map[string]int)
	sourceCategoryOrder := make([]string, 0, len(documents))

	for _, document := range documents {
		result := document.Result
		categoryPath := rawString(result.CategoryPath)

		method := normalizeMethod(rawString(result.CategoryMethod))
		methodGroup := "llm_embedding_rerank"
		if strings.HasPrefix(method, "rule") || strings.HasPrefix(method, "fallback") {
			methodGroup = "rule_fallback"
		}
		methodCounters[methodGroup]++

		confidence := rawConfidence(result.CategoryConfidence)
		if confidence == nil {
			continue
		}
		confidenceValues = append(confidenceValues, *confidence)
		createdAt := time.Now().UTC()
		if parsed := rawTime(document.CreatedAt); parsed != nil {
			createdAt = *parsed
		}
		bucketStart := floorBucket(createdAt, bucketMinutes).UnixMilli()
		bucket, ok := trendBuckets[bucketStart]
		if !ok {
			bucket = &trendBucket{}
			trendBuckets[bucketStart] = bucket
			trendOrder = append(trendOrder, bucketStart)
		}
		bucket.total++
		bucket.sum += *confidence
		if *confidence < settings.LowConfidenceThreshold {
			bucket.low++
		}

		sourceID := "unknown"
		if parsed := rawString(document.SourceID); parsed != nil {
			sourceID = *parsed
		}
		sourceEntry, ok := lowBySource[sourceID]
		if !ok {
			sourceEntry = &sourceBucket{}
			lowBySource[sourceID] = sourceEntry
			lowSourceOrder = append(lowSourceOrder, sourceID)
		}
		sourceEntry.total++
		sourceEntry.sum += *confidence
		if *confidence < settings.LowConfidenceThreshold {
			sourceEntry.low++
		}

		sourceType := s.classifyBySource(ctx, request.OrgID, sourceID, &result, nil, sourceMap, policy)
		categoryKeyValue := sourceTypeKey(sourceType, categoryPath)
		if _, ok := sourceCategory[categoryKeyValue]; !ok {
			sourceCategoryOrder = append(sourceCategoryOrder, categoryKeyValue)
		}
		sourceCategory[categoryKeyValue]++
	}

	methodTotal := methodCounters["llm_embedding_rerank"] + methodCounters["rule_fallback"]
	methodDistribution := []methodDistributionEntry{
		{Group: "llm_embedding_rerank", Count: methodCounters["llm_embedding_rerank"]},
		{Group: "rule_fallback", Count: methodCounters["rule_fallback"]},
	}
	for index := range methodDistribution {
		if methodTotal > 0 {
			methodDistribution[index].Share = round4(float64(methodDistribution[index].Count) / float64(methodTotal))
		}
	}

	confidenceHistogram := buildHistogram(confidenceValues, 10)

	sort.SliceStable(trendOrder, func(left, right int) bool { return trendOrder[left] < trendOrder[right] })
	confidenceTrend := make([]confidenceTrendEntry, 0, len(trendOrder))
	for _, bucketStart := range trendOrder {
		bucket := trendBuckets[bucketStart]
		entry := confidenceTrendEntry{
			BucketStart:        formatJSTime(time.UnixMilli(bucketStart).UTC()),
			Total:              bucket.total,
			LowConfidenceCount: bucket.low,
		}
		if bucket.total > 0 {
			average := round4(bucket.sum / float64(bucket.total))
			entry.AvgConfidence = &average
		}
		confidenceTrend = append(confidenceTrend, entry)
	}

	lowConfidenceSources := make([]lowConfidenceSource, 0, len(lowSourceOrder))
	for _, sourceID := range lowSourceOrder {
		entry := lowBySource[sourceID]
		item := lowConfidenceSource{
			SourceID:           sourceID,
			SourceName:         sourceID,
			Total:              entry.total,
			LowConfidenceCount: entry.low,
			LowConfidenceRate:  ratio4(float64(entry.low), float64(entry.total), 0),
		}
		if name, ok := sourceMap[sourceID]; ok {
			item.SourceName = name.Name
			item.SourceURL = name.URL
		}
		if entry.total > 0 {
			average := round4(entry.sum / float64(entry.total))
			item.AvgConfidence = &average
		}
		lowConfidenceSources = append(lowConfidenceSources, item)
	}
	sort.SliceStable(lowConfidenceSources, func(left, right int) bool {
		return lowConfidenceSources[left].LowConfidenceCount > lowConfidenceSources[right].LowConfidenceCount
	})
	if len(lowConfidenceSources) > 10 {
		lowConfidenceSources = lowConfidenceSources[:10]
	}

	latency, latencyMeta, err := s.computeLatencyPercentiles(ctx, request.OrgID, from, to)
	if err != nil {
		return classificationQualitySummary{}, err
	}
	categoryGate, gateMeta, err := s.computeCategoryGateStats(ctx, request.OrgID, from, to)
	if err != nil {
		return classificationQualitySummary{}, err
	}

	sourceCategoryBreakdown := make([]sourceCategoryEntry, 0, len(sourceCategoryOrder))
	for _, key := range sourceCategoryOrder {
		sourceType, prefix := splitSourceCategoryKey(key)
		sourceCategoryBreakdown = append(sourceCategoryBreakdown, sourceCategoryEntry{
			SourceType:     sourceType,
			CategoryPrefix: prefix,
			Count:          sourceCategory[key],
		})
	}
	sort.SliceStable(sourceCategoryBreakdown, func(left, right int) bool {
		return sourceCategoryBreakdown[left].Count > sourceCategoryBreakdown[right].Count
	})
	if len(sourceCategoryBreakdown) > 30 {
		sourceCategoryBreakdown = sourceCategoryBreakdown[:30]
	}

	reviews, err := s.collection(reviewsCollection)
	if err != nil {
		return classificationQualitySummary{}, err
	}
	pendingReviewCount, err := reviews.CountDocuments(ctx, bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "status", Value: "pending"},
	})
	if err != nil {
		return classificationQualitySummary{}, err
	}

	alertStatus := []latencyAlert{
		{
			Stage:       "llm",
			ThresholdMs: settings.LLMP95LatencyWarnMs,
			P95Ms:       latency.LLM.P95Ms,
			Triggered:   latency.LLM.P95Ms != nil && *latency.LLM.P95Ms > float64(settings.LLMP95LatencyWarnMs),
		},
		{
			Stage:       "embedding",
			ThresholdMs: settings.EmbeddingP95LatencyWarnMs,
			P95Ms:       latency.Embedding.P95Ms,
			Triggered:   latency.Embedding.P95Ms != nil && *latency.Embedding.P95Ms > float64(settings.EmbeddingP95LatencyWarnMs),
		},
		{
			Stage:       "rerank",
			ThresholdMs: settings.RerankP95LatencyWarnMs,
			P95Ms:       latency.Rerank.P95Ms,
			Triggered:   latency.Rerank.P95Ms != nil && *latency.Rerank.P95Ms > float64(settings.RerankP95LatencyWarnMs),
		},
	}
	gateAlertStatus := []gateAlert{
		{
			Metric:    "reject_rate",
			Threshold: settings.GateRejectRateWarn,
			Value:     categoryGate.RejectRate,
			Triggered: categoryGate.RejectRate > settings.GateRejectRateWarn,
		},
		{
			Metric:    "penalized_rate",
			Threshold: settings.GatePenalizedRateWarn,
			Value:     categoryGate.PenalizedRate,
			Triggered: categoryGate.PenalizedRate > settings.GatePenalizedRateWarn,
		},
	}
	for _, alert := range alertStatus {
		if alert.Triggered {
			log.Printf("classification rss ops: latency threshold exceeded org=%s window=%s stage=%s p95=%s threshold=%d",
				request.OrgID, request.Window, alert.Stage, formatLatencyValue(alert.P95Ms), alert.ThresholdMs)
		}
	}
	for _, alert := range gateAlertStatus {
		if alert.Triggered {
			log.Printf("classification rss ops: category gate threshold exceeded org=%s window=%s metric=%s value=%v threshold=%v",
				request.OrgID, request.Window, alert.Metric, alert.Value, alert.Threshold)
		}
	}

	s.notifyThresholdBreaches(ctx, request.OrgID, request.Window, alertStatus, gateAlertStatus)

	return classificationQualitySummary{
		Window:                  request.Window,
		From:                    formatJSTime(from),
		To:                      formatJSTime(to),
		TotalItems:              int(totalMatchedItems),
		MethodDistribution:      methodDistribution,
		ConfidenceHistogram:     confidenceHistogram,
		ConfidenceTrend:         confidenceTrend,
		LowConfidenceSources:    lowConfidenceSources,
		LatencyPercentiles:      latency,
		CategoryGate:            categoryGate,
		SourceCategoryBreakdown: sourceCategoryBreakdown,
		PendingReviewCount:      int(pendingReviewCount),
		AlertStatus:             alertStatus,
		GateAlertStatus:         gateAlertStatus,
		Sampling: summarySampling{
			ClassifiedItems: toSamplingMeta(int(totalMatchedItems), len(documents), summaryItemsLimit),
			LatencyLogs:     latencyMeta,
			GateLogs:        gateMeta,
		},
	}, nil
}

// processedItemsFilter builds the processeditems $match document. The category
// prefix is applied through the same anchored regex the NestJS RegExp produces.
func processedItemsFilter(orgID string, from, to time.Time, sourceID *string, categoryPrefixRegex *string) bson.D {
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}},
	}
	if sourceID != nil {
		filter = append(filter, bson.E{Key: "sourceId", Value: *sourceID})
	}
	if categoryPrefixRegex != nil {
		filter = append(filter, bson.E{Key: "result.category_path", Value: bson.D{{Key: "$regex", Value: *categoryPrefixRegex}}})
	}
	return filter
}

// sourceTypeKey encodes the `${sourceType}|${categoryPrefix}` map key.
func sourceTypeKey(sourceType ClassifiedSourceType, categoryPath *string) string {
	return string(sourceType) + "|" + extractCategoryPrefix(categoryPath)
}

// splitSourceCategoryKey decodes the key built by sourceTypeKey. Only the first
// separator splits, exactly like the NestJS destructuring of key.split("|").
func splitSourceCategoryKey(key string) (ClassifiedSourceType, string) {
	index := strings.Index(key, "|")
	if index < 0 {
		return ClassifiedSourceUnknown, categoryPrefixUnknown
	}
	sourceType := ClassifiedSourceType(key[:index])
	if sourceType == "" {
		sourceType = ClassifiedSourceUnknown
	}
	prefix := key[index+1:]
	if prefix == "" {
		prefix = categoryPrefixUnknown
	}
	return sourceType, prefix
}

// classifyBySource mirrors the source-type resolution used by both the summary
// and the sampling query: the NewsSource row wins over the stored result source,
// and the article context is the URL fallback.
func (s *Service) classifyBySource(
	ctx context.Context,
	orgID, sourceID string,
	result *processedItemResultDocument,
	articleContextEntry *articleContext,
	sourceMap map[string]sourceInfo,
	policy newsEventSourcePolicy,
) ClassifiedSourceType {
	var label *string
	var rawURL *string
	if result != nil {
		label = rawString(result.Source)
	}
	if entry, ok := sourceMap[sourceID]; ok && sourceID != "" {
		name := entry.Name
		url := entry.URL
		label = &name
		rawURL = &url
	}
	if rawURL == nil && articleContextEntry != nil {
		rawURL = articleContextEntry.ArticleURL
	}
	return classifySourceByLabelAndURL(label, rawURL, policy)
}

// computeLatencyPercentiles mirrors the private computeLatencyPercentiles helper.
func (s *Service) computeLatencyPercentiles(ctx context.Context, orgID string, from, to time.Time) (latencyPercentileSet, samplingMeta, error) {
	collection, err := s.collection(taskLogsCollection)
	if err != nil {
		return latencyPercentileSet{}, samplingMeta{}, err
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "queue", Value: classifyQueue},
		{Key: "stage", Value: classifyStage},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}},
	}
	matched, err := collection.CountDocuments(ctx, filter)
	if err != nil {
		return latencyPercentileSet{}, samplingMeta{}, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(latencyLogsLimit).
		SetProjection(bson.D{
			{Key: "data.llmLatencyMs", Value: 1},
			{Key: "data.embeddingLatencyMs", Value: 1},
			{Key: "data.rerankLatencyMs", Value: 1},
		}))
	if err != nil {
		return latencyPercentileSet{}, samplingMeta{}, err
	}
	var documents []taskLogLatencyDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return latencyPercentileSet{}, samplingMeta{}, err
	}

	llm := make([]float64, 0, len(documents))
	embedding := make([]float64, 0, len(documents))
	rerank := make([]float64, 0, len(documents))
	for _, document := range documents {
		if value := rawNumber(document.Data.LLMLatencyMs); value != nil && *value >= 0 {
			llm = append(llm, *value)
		}
		if value := rawNumber(document.Data.EmbeddingLatencyMs); value != nil && *value >= 0 {
			embedding = append(embedding, *value)
		}
		if value := rawNumber(document.Data.RerankLatencyMs); value != nil && *value >= 0 {
			rerank = append(rerank, *value)
		}
	}
	return latencyPercentileSet{
			LLM:       percentilesOf(llm),
			Embedding: percentilesOf(embedding),
			Rerank:    percentilesOf(rerank),
		},
		toSamplingMeta(int(matched), len(documents), latencyLogsLimit), nil
}

// percentilesOf sorts a stage sample and reports the p50/p95/p99 triple.
func percentilesOf(values []float64) latencyPercentiles {
	sorted := append([]float64{}, values...)
	sort.Float64s(sorted)
	return latencyPercentiles{
		SampleSize: len(sorted),
		P50Ms:      percentile(sorted, 0.5),
		P95Ms:      percentile(sorted, 0.95),
		P99Ms:      percentile(sorted, 0.99),
	}
}

// computeCategoryGateStats mirrors the private computeCategoryGateStats helper.
func (s *Service) computeCategoryGateStats(ctx context.Context, orgID string, from, to time.Time) (categoryGateStats, samplingMeta, error) {
	collection, err := s.collection(taskLogsCollection)
	if err != nil {
		return categoryGateStats{}, samplingMeta{}, err
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "queue", Value: categoryGateQueue},
		{Key: "stage", Value: categoryGateStage},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}},
	}
	matched, err := collection.CountDocuments(ctx, filter)
	if err != nil {
		return categoryGateStats{}, samplingMeta{}, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(gateLogsLimit).
		SetProjection(bson.D{{Key: "data.decision", Value: 1}}))
	if err != nil {
		return categoryGateStats{}, samplingMeta{}, err
	}
	var documents []taskLogGateDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return categoryGateStats{}, samplingMeta{}, err
	}

	reject, penalized, accepted := 0, 0, 0
	for _, document := range documents {
		decision := rawString(document.Data.Decision)
		if decision == nil {
			continue
		}
		switch *decision {
		case "reject":
			reject++
		case "penalized":
			penalized++
		case "accepted":
			accepted++
		}
	}
	total := reject + penalized + accepted
	return categoryGateStats{
			Reject:        reject,
			Penalized:     penalized,
			Total:         total,
			RejectRate:    ratio4(float64(reject), float64(total), 0),
			PenalizedRate: ratio4(float64(penalized), float64(total), 0),
		},
		toSamplingMeta(int(matched), len(documents), gateLogsLimit), nil
}

// notifyThresholdBreaches mirrors the private notifyThresholdBreaches helper: a
// Redis NX throttle per alert signature, then one Notification row per active
// member holding settings.manage.
func (s *Service) notifyThresholdBreaches(
	ctx context.Context,
	orgID string,
	window QualityWindow,
	latencyAlerts []latencyAlert,
	gateAlerts []gateAlert,
) {
	triggeredLatency := make([]latencyAlert, 0, len(latencyAlerts))
	for _, alert := range latencyAlerts {
		if alert.Triggered {
			triggeredLatency = append(triggeredLatency, alert)
		}
	}
	triggeredGate := make([]gateAlert, 0, len(gateAlerts))
	for _, alert := range gateAlerts {
		if alert.Triggered {
			triggeredGate = append(triggeredGate, alert)
		}
	}
	if len(triggeredLatency) == 0 && len(triggeredGate) == 0 {
		return
	}

	signatureParts := make([]string, 0, len(triggeredLatency)+len(triggeredGate))
	for _, alert := range triggeredLatency {
		signatureParts = append(signatureParts, "latency:"+alert.Stage)
	}
	for _, alert := range triggeredGate {
		signatureParts = append(signatureParts, "gate:"+alert.Metric)
	}
	sort.Strings(signatureParts)
	signature := strings.Join(signatureParts, "|")
	if signature == "" {
		return
	}

	throttleKey := alertNotificationCachePrefix + orgID + ":" + string(window) + ":" + signature
	shouldNotify := false
	throttlePayload, marshalErr := json.Marshal(struct {
		TriggeredAt string `json:"triggeredAt"`
		Signature   string `json:"signature"`
	}{TriggeredAt: formatJSTime(nowMillis()), Signature: signature})
	if marshalErr == nil {
		inserted, err := s.store.setIfAbsent(ctx, throttleKey, throttlePayload, alertNotificationTTLSecs)
		if err != nil {
			log.Printf("classification rss ops: alert throttle check failed org=%s window=%s: %v", orgID, window, err)
			shouldNotify = true
		} else {
			shouldNotify = inserted
		}
	} else {
		shouldNotify = true
	}
	if !shouldNotify {
		return
	}

	latencySummaryParts := make([]string, 0, len(triggeredLatency))
	for _, alert := range triggeredLatency {
		latencySummaryParts = append(latencySummaryParts, alert.Stage+" p95="+formatLatencyValue(alert.P95Ms)+"ms > "+itoa(alert.ThresholdMs)+"ms")
	}
	gateSummaryParts := make([]string, 0, len(triggeredGate))
	for _, alert := range triggeredGate {
		gateSummaryParts = append(gateSummaryParts, alert.Metric+"="+formatPercent(alert.Value)+"% > "+formatPercent(alert.Threshold)+"%")
	}
	latencySummary := strings.Join(latencySummaryParts, ", ")
	gateSummary := strings.Join(gateSummaryParts, ", ")
	bodyParts := make([]string, 0, 2)
	if latencySummary != "" {
		bodyParts = append(bodyParts, "Latency alerts: "+latencySummary)
	}
	if gateSummary != "" {
		bodyParts = append(bodyParts, "Category gate alerts: "+gateSummary)
	}
	body := strings.Join(bodyParts, " | ")

	latencyStages := make([]string, 0, len(triggeredLatency))
	for _, alert := range triggeredLatency {
		latencyStages = append(latencyStages, alert.Stage)
	}
	gateMetrics := make([]string, 0, len(triggeredGate))
	for _, alert := range triggeredGate {
		gateMetrics = append(gateMetrics, alert.Metric)
	}

	data := classificationAlertNotificationData{
		Domain:        "classification_quality",
		Window:        window,
		LatencyAlerts: triggeredLatency,
		GateAlerts:    triggeredGate,
		Presentation: notificationPresentation{
			Kind: presentationKindClassificationQualityThreshold,
			Params: notificationPresentationParams{
				Window:            window,
				LatencyAlertCount: len(triggeredLatency),
				GateAlertCount:    len(triggeredGate),
				LatencySummary:    latencySummary,
				GateSummary:       gateSummary,
				LatencyStages:     latencyStages,
				GateMetrics:       gateMetrics,
			},
			TechnicalDetail: body,
		},
	}

	recipients, err := s.alertRecipientUserIDs(ctx, orgID)
	if err != nil {
		log.Printf("classification rss ops: failed to load alert recipients org=%s window=%s: %v", orgID, window, err)
		return
	}
	if len(recipients) == 0 {
		if err := s.writeClassificationAlertNotification(ctx, orgID, nil, body, data); err != nil {
			log.Printf("classification rss ops: failed to write broadcast notification org=%s window=%s: %v", orgID, window, err)
		}
		return
	}
	failures := 0
	for index := range recipients {
		userID := recipients[index]
		if err := s.writeClassificationAlertNotification(ctx, orgID, &userID, body, data); err != nil {
			failures++
			log.Printf("classification rss ops: failed to write notification org=%s user=%s: %v", orgID, userID, err)
		}
	}
	if failures > 0 {
		log.Printf("classification rss ops: %d/%d classification notifications failed org=%s window=%s signature=%s",
			failures, len(recipients), orgID, window, signature)
	}
}

// formatLatencyValue renders `entry.p95Ms ?? "-"`.
func formatLatencyValue(value *float64) string {
	if value == nil {
		return "-"
	}
	return trimFloat(*value)
}

// formatPercent mirrors Number((value * 100).toFixed(2)).
func formatPercent(value float64) string {
	return trimFloat(math.Round(value*100) / 100)
}

// LowConfidenceSourceItems mirrors getLowConfidenceSourceItems.
func (s *Service) LowConfidenceSourceItems(ctx context.Context, request sourceItemsRequest) (sourceItemsResponse, error) {
	from, to, _ := resolveWindow(request.Window)
	settings := s.qualitySettingsFor(ctx, request.OrgID)
	maxConfidence := settings.LowConfidenceThreshold
	if request.MaxConfidence != nil && !math.IsNaN(*request.MaxConfidence) && !math.IsInf(*request.MaxConfidence, 0) {
		maxConfidence = math.Max(0, math.Min(1, *request.MaxConfidence))
	}
	limit := sourceItemsLimitDefault
	if request.Limit != nil {
		limit = *request.Limit
	}
	limit = maxInt(1, minInt(sourceItemsLimitMax, limit))
	beforeCursor := parseCursor(request.Cursor)

	createdAt := bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}
	if beforeCursor != nil {
		createdAt = append(createdAt, bson.E{Key: "$lt", Value: *beforeCursor})
	}
	filter := bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "sourceId", Value: request.SourceID},
		{Key: "createdAt", Value: createdAt},
		{Key: "result.category_confidence", Value: bson.D{
			{Key: "$type", Value: "number"},
			{Key: "$lte", Value: maxConfidence},
		}},
	}

	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return sourceItemsResponse{}, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "result.title", Value: 1},
			{Key: "result.summary", Value: 1},
			{Key: "result.category_path", Value: 1},
			{Key: "result.category_confidence", Value: 1},
			{Key: "result.category_method", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)))
	if err != nil {
		return sourceItemsResponse{}, err
	}
	var documents []processedItemDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return sourceItemsResponse{}, err
	}

	processedItemIDs := make([]string, 0, len(documents))
	for _, document := range documents {
		if id := rawIDString(document.ID); id != "" {
			processedItemIDs = append(processedItemIDs, id)
		}
	}
	articleContexts, err := s.loadArticleContexts(ctx, request.OrgID, processedItemIDs)
	if err != nil {
		return sourceItemsResponse{}, err
	}

	items := make([]lowConfidenceItem, 0, len(documents))
	for _, document := range documents {
		processedItemID := rawIDString(document.ID)
		entry, ok := articleContexts[processedItemID]
		var articleURL *string
		if ok {
			articleURL = entry.ArticleURL
		}
		createdAtValue := time.Now().UTC()
		if parsed := rawTime(document.CreatedAt); parsed != nil {
			createdAtValue = *parsed
		}
		items = append(items, lowConfidenceItem{
			ProcessedItemID: processedItemID,
			ItemMetaID:      rawString(document.ItemMetaID),
			ArticleURL:      articleURL,
			ArticleTitle:    rawString(document.Result.Title),
			ArticleSummary:  rawString(document.Result.Summary),
			CategoryPath:    rawString(document.Result.CategoryPath),
			Confidence:      rawConfidence(document.Result.CategoryConfidence),
			Method:          rawString(document.Result.CategoryMethod),
			CreatedAt:       formatJSTime(createdAtValue),
		})
	}

	var nextCursor *string
	if len(documents) > 0 {
		if parsed := rawTime(documents[len(documents)-1].CreatedAt); parsed != nil {
			value := formatJSTime(*parsed)
			nextCursor = &value
		}
	}

	return sourceItemsResponse{
		SourceID:   request.SourceID,
		From:       formatJSTime(from),
		To:         formatJSTime(to),
		Items:      items,
		NextCursor: nextCursor,
	}, nil
}

// ListReviewQueue mirrors listReviewQueue.
func (s *Service) ListReviewQueue(ctx context.Context, request reviewQueueRequest) ([]reviewQueueRow, error) {
	from, to, _ := resolveWindow(request.Window)
	limit := reviewQueueLimitDefault
	if request.Limit != nil {
		limit = *request.Limit
	}
	limit = maxInt(1, minInt(reviewQueueLimitMax, limit))

	filter := bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}},
	}
	if request.OnlyUnreviewed {
		filter = append(filter, bson.E{Key: "status", Value: "pending"})
	}
	if request.MaxConfidence != nil {
		filter = append(filter, bson.E{Key: "predictedConfidence", Value: bson.D{
			{Key: "$lte", Value: math.Max(0, math.Min(1, *request.MaxConfidence))},
		}})
	}

	collection, err := s.collection(reviewsCollection)
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetProjection(reviewQueueProjection()).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	var documents []classificationReviewDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return nil, err
	}

	rows := make([]reviewQueueRow, 0, len(documents))
	for _, document := range documents {
		rows = append(rows, reviewQueueRowFromDocument(document))
	}
	return rows, nil
}

// reviewQueueProjection is the explicit field list of listReviewQueue.
func reviewQueueProjection() bson.D {
	return bson.D{
		{Key: "_id", Value: 1},
		{Key: "evidenceId", Value: 1},
		{Key: "processedItemId", Value: 1},
		{Key: "itemMetaId", Value: 1},
		{Key: "sourceId", Value: 1},
		{Key: "sourceType", Value: 1},
		{Key: "articleUrl", Value: 1},
		{Key: "articleTitle", Value: 1},
		{Key: "articleSummary", Value: 1},
		{Key: "predictedCategoryPath", Value: 1},
		{Key: "predictedLegacyCategory", Value: 1},
		{Key: "predictedConfidence", Value: 1},
		{Key: "predictedMethod", Value: 1},
		{Key: "candidatePaths", Value: 1},
		{Key: "status", Value: 1},
		{Key: "correctedCategoryPath", Value: 1},
		{Key: "note", Value: 1},
		{Key: "quickTags", Value: 1},
		{Key: "reviewerId", Value: 1},
		{Key: "reviewedAt", Value: 1},
		{Key: "createdAt", Value: 1},
		{Key: "updatedAt", Value: 1},
	}
}

// reviewQueueRowFromDocument maps one stored review into the list row.
func reviewQueueRowFromDocument(document classificationReviewDocument) reviewQueueRow {
	status := rawString(document.Status)
	statusValue := "pending"
	if status != nil {
		statusValue = *status
	}
	createdAt := time.Now().UTC()
	if parsed := rawTime(document.CreatedAt); parsed != nil {
		createdAt = *parsed
	}
	updatedAt := time.Now().UTC()
	if parsed := rawTime(document.UpdatedAt); parsed != nil {
		updatedAt = *parsed
	}
	var reviewedAt *string
	if parsed := rawTime(document.ReviewedAt); parsed != nil {
		value := formatJSTime(*parsed)
		reviewedAt = &value
	}
	return reviewQueueRow{
		ID:                      rawIDString(document.ID),
		EvidenceID:              rawString(document.EvidenceID),
		ProcessedItemID:         rawString(document.ProcessedItemID),
		ItemMetaID:              rawString(document.ItemMetaID),
		SourceID:                rawString(document.SourceID),
		SourceType:              rawString(document.SourceType),
		ArticleURL:              rawString(document.ArticleURL),
		ArticleTitle:            rawString(document.ArticleTitle),
		ArticleSummary:          rawString(document.ArticleSummary),
		PredictedCategoryPath:   rawString(document.PredictedCategoryPath),
		PredictedLegacyCategory: rawString(document.PredictedLegacyCategory),
		PredictedConfidence:     rawConfidence(document.PredictedConfidence),
		PredictedMethod:         rawString(document.PredictedMethod),
		CandidatePaths:          candidatePathsFromRaw(document.CandidatePaths),
		Status:                  statusValue,
		CorrectedCategoryPath:   rawString(document.CorrectedCategoryPath),
		Note:                    rawString(document.Note),
		QuickTags:               rawStringArray(document.QuickTags),
		ReviewerID:              rawString(document.ReviewerID),
		ReviewedAt:              reviewedAt,
		CreatedAt:               formatJSTime(createdAt),
		UpdatedAt:               formatJSTime(updatedAt),
	}
}

// candidatePathsFromRaw decodes the candidatePaths array without widening it.
func candidatePathsFromRaw(value bson.RawValue) []candidatePath {
	out := []candidatePath{}
	if value.Type != bson.TypeArray {
		return out
	}
	var rawItems []bson.RawValue
	if err := value.Unmarshal(&rawItems); err != nil {
		return out
	}
	for _, rawItem := range rawItems {
		if rawItem.Type != bson.TypeEmbeddedDocument {
			continue
		}
		var document struct {
			Path           bson.RawValue `bson:"path"`
			Score          bson.RawValue `bson:"score"`
			LegacyCategory bson.RawValue `bson:"legacy_category"`
			Reason         bson.RawValue `bson:"reason"`
		}
		if err := rawItem.Unmarshal(&document); err != nil {
			continue
		}
		out = append(out, candidatePath{
			Path:           newOptionalString(document.Path),
			Score:          newOptionalNumber(document.Score),
			LegacyCategory: newOptionalString(document.LegacyCategory),
			Reason:         newOptionalString(document.Reason),
		})
	}
	return out
}

// reviewDocumentToResponse maps a stored review into the raw document response
// returned by the single decision endpoint.
func reviewDocumentToResponse(document classificationReviewDocument) classificationReviewResponse {
	return classificationReviewResponse{
		ID:                      rawIDString(document.ID),
		OrgID:                   newOptionalString(document.OrgID),
		EvidenceID:              newOptionalString(document.EvidenceID),
		ProcessedItemID:         newOptionalString(document.ProcessedItemID),
		ItemMetaID:              newOptionalString(document.ItemMetaID),
		SourceID:                newOptionalString(document.SourceID),
		SourceType:              newOptionalString(document.SourceType),
		ArticleURL:              newOptionalString(document.ArticleURL),
		ArticleTitle:            newOptionalString(document.ArticleTitle),
		ArticleSummary:          newOptionalString(document.ArticleSummary),
		PredictedCategoryPath:   newOptionalString(document.PredictedCategoryPath),
		PredictedLegacyCategory: newOptionalString(document.PredictedLegacyCategory),
		PredictedConfidence:     newOptionalNumber(document.PredictedConfidence),
		PredictedMethod:         newOptionalString(document.PredictedMethod),
		CandidatePaths:          candidatePathsFromRaw(document.CandidatePaths),
		Status:                  newOptionalString(document.Status),
		CorrectedCategoryPath:   newOptionalString(document.CorrectedCategoryPath),
		Note:                    newOptionalString(document.Note),
		QuickTags:               rawStringArray(document.QuickTags),
		ReviewerID:              newOptionalString(document.ReviewerID),
		ReviewedAt:              newOptionalTime(document.ReviewedAt),
		ExpiresAt:               newOptionalTime(document.ExpiresAt),
		Version:                 newOptionalNumber(document.Version),
		CreatedAt:               newOptionalTime(document.CreatedAt),
		UpdatedAt:               newOptionalTime(document.UpdatedAt),
	}
}

// correctedCategoryPath validates and normalizes a corrected path. It is the
// shared implementation of the defect-2 fix: a path that normalizes to nothing
// (for example "///") is rejected instead of being stored as null.
func correctedCategoryPath(status ReviewDecisionStatus, raw *string) (*string, error) {
	if status != ReviewDecisionCorrected {
		return nil, nil
	}
	normalized := normalizePath(derefString(raw))
	if normalized == nil {
		return nil, newStatus(400, "correctedCategoryPath is required when status=corrected")
	}
	return normalized, nil
}

// SubmitReviewDecision mirrors submitReviewDecision including the ObjectId guard
// (defect 1) and the corrected-path validation (defect 2).
func (s *Service) SubmitReviewDecision(ctx context.Context, request reviewDecisionRequest) (classificationReviewResponse, error) {
	reviewID := strings.TrimSpace(request.ReviewID)
	if reviewID == "" {
		return classificationReviewResponse{}, newStatus(400, "reviewId is required")
	}

	// The corrected-path validation runs first so an unusable path is rejected
	// even when the id itself is malformed, matching the controller pre-check
	// order in NestJS.
	normalizedCorrectedPath, err := correctedCategoryPath(request.Status, request.CorrectedCategoryPath)
	if err != nil {
		return classificationReviewResponse{}, err
	}
	if !validObjectID(reviewID) {
		return classificationReviewResponse{}, newStatus(404, "Review item not found")
	}
	objectID, err := bson.ObjectIDFromHex(reviewID)
	if err != nil {
		return classificationReviewResponse{}, newStatus(404, "Review item not found")
	}

	collection, err := s.collection(reviewsCollection)
	if err != nil {
		return classificationReviewResponse{}, err
	}
	filter := bson.D{{Key: "_id", Value: objectID}, {Key: "orgId", Value: request.OrgID}}
	var existing classificationReviewDocument
	if err := collection.FindOne(ctx, filter).Decode(&existing); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return classificationReviewResponse{}, newStatus(404, "Review item not found")
		}
		return classificationReviewResponse{}, err
	}

	now := nowMillis()
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: request.Status},
		{Key: "correctedCategoryPath", Value: normalizedCorrectedPath},
		{Key: "note", Value: normalizeText(derefString(request.Note), 500)},
		{Key: "quickTags", Value: normalizeQuickTags(request.QuickTags)},
		{Key: "reviewerId", Value: request.ActorID},
		{Key: "reviewedAt", Value: now},
		{Key: "updatedAt", Value: now},
	}}}
	if _, err := collection.UpdateOne(ctx, filter, update); err != nil {
		return classificationReviewResponse{}, err
	}

	metadata, err := json.Marshal(reviewDecisionAuditMetadata{ReviewID: reviewID, Status: request.Status})
	if err != nil {
		return classificationReviewResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, request.OrgID, auditActorID(request.ActorID),
		"classification_review", "classification_review_decision", metadata)

	var updated classificationReviewDocument
	if err := collection.FindOne(ctx, filter).Decode(&updated); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return classificationReviewResponse{}, newStatus(404, "Review item not found")
		}
		return classificationReviewResponse{}, err
	}
	return reviewDocumentToResponse(updated), nil
}

// BatchReviewDecision mirrors batchReviewDecision including the invalid-ObjectId
// filtering (defect 1) and the corrected-path validation (defect 2).
func (s *Service) BatchReviewDecision(ctx context.Context, request batchReviewDecisionRequest) (batchDecisionResult, error) {
	normalizedCorrectedPath, err := correctedCategoryPath(request.Status, request.CorrectedCategoryPath)
	if err != nil {
		return batchDecisionResult{}, err
	}

	seen := make(map[string]bool, len(request.ReviewIDs))
	reviewIDs := make([]string, 0, len(request.ReviewIDs))
	for _, entry := range request.ReviewIDs {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		reviewIDs = append(reviewIDs, trimmed)
		if len(reviewIDs) >= maxReviewBatchIDs {
			break
		}
	}
	if len(reviewIDs) == 0 {
		return batchDecisionResult{Matched: 0, Modified: 0}, nil
	}

	// A single malformed id must not crash the whole batch: Mongoose would raise
	// a CastError for the entire $in filter, so invalid ids are dropped here.
	objectIDs := make([]bson.ObjectID, 0, len(reviewIDs))
	for _, reviewID := range reviewIDs {
		if !validObjectID(reviewID) {
			continue
		}
		objectID, err := bson.ObjectIDFromHex(reviewID)
		if err != nil {
			continue
		}
		objectIDs = append(objectIDs, objectID)
	}
	if len(objectIDs) == 0 {
		return batchDecisionResult{Matched: 0, Modified: 0}, nil
	}

	collection, err := s.collection(reviewsCollection)
	if err != nil {
		return batchDecisionResult{}, err
	}
	now := nowMillis()
	filter := bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "_id", Value: bson.D{{Key: "$in", Value: objectIDs}}},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: request.Status},
		{Key: "correctedCategoryPath", Value: normalizedCorrectedPath},
		{Key: "note", Value: normalizeText(derefString(request.Note), 500)},
		{Key: "quickTags", Value: normalizeQuickTags(request.QuickTags)},
		{Key: "reviewerId", Value: request.ActorID},
		{Key: "reviewedAt", Value: now},
		{Key: "updatedAt", Value: now},
	}}}
	result, err := collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return batchDecisionResult{}, err
	}

	metadata, err := json.Marshal(reviewBatchAuditMetadata{Count: len(reviewIDs), Status: request.Status})
	if err != nil {
		return batchDecisionResult{}, err
	}
	s.writeAuditLogBestEffort(ctx, request.OrgID, auditActorID(request.ActorID),
		"classification_review", "classification_review_batch_decision", metadata)

	return batchDecisionResult{Matched: int(result.MatchedCount), Modified: int(result.ModifiedCount)}, nil
}

// CreateSample mirrors createSample: stratified sampling by
// `${confidenceBand}|${method}` with a per-stratum cap, persisted with a
// 180-day expiry.
func (s *Service) CreateSample(ctx context.Context, request samplingRequest) (samplingQueryResponse, error) {
	from, to, _ := resolveWindow(request.Window)
	policy := s.sourcePolicyFor(ctx, request.OrgID)

	sourceFilter := orderedSet(request.SourceIDs)
	methodFilter := orderedSet(request.Methods)
	bandFilter := orderedSet(confidenceBandStrings(request.ConfidenceBands))
	bandValues := make([]ConfidenceBand, 0, len(bandFilter))
	for _, band := range bandFilter {
		bandValues = append(bandValues, ConfidenceBand(band))
	}
	perStratum := 20
	if request.PerStratum != nil {
		perStratum = *request.PerStratum
	}
	perStratum = maxInt(1, minInt(200, perStratum))

	normalizedCategoryPrefix := normalizePath(derefString(request.CategoryPrefix))
	var categoryPrefixRegex *string
	if normalizedCategoryPrefix != nil {
		pattern := buildCategoryPrefixRegex(*normalizedCategoryPrefix)
		categoryPrefixRegex = &pattern
	}

	filter := bson.D{
		{Key: "orgId", Value: request.OrgID},
		{Key: "status", Value: pipelineStatusCompleted},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}},
		{Key: "result.category_confidence", Value: bson.D{{Key: "$type", Value: "number"}}},
	}
	if len(sourceFilter) > 0 {
		filter = append(filter, bson.E{Key: "sourceId", Value: bson.D{{Key: "$in", Value: sourceFilter}}})
	}
	if len(methodFilter) > 0 {
		filter = append(filter, bson.E{Key: "result.category_method", Value: bson.D{{Key: "$in", Value: methodFilter}}})
	}
	if categoryPrefixRegex != nil {
		filter = append(filter, bson.E{Key: "result.category_path", Value: bson.D{{Key: "$regex", Value: *categoryPrefixRegex}}})
	}

	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return samplingQueryResponse{}, err
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "itemMetaId", Value: 1},
			{Key: "sourceId", Value: 1},
			{Key: "createdAt", Value: 1},
			{Key: "result.title", Value: 1},
			{Key: "result.summary", Value: 1},
			{Key: "result.source", Value: 1},
			{Key: "result.category", Value: 1},
			{Key: "result.category_path", Value: 1},
			{Key: "result.category_confidence", Value: 1},
			{Key: "result.category_method", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(samplingFetchLimit))
	if err != nil {
		return samplingQueryResponse{}, err
	}
	var documents []processedItemDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return samplingQueryResponse{}, err
	}

	processedItemIDs := make([]string, 0, len(documents))
	for _, document := range documents {
		if id := rawIDString(document.ID); id != "" {
			processedItemIDs = append(processedItemIDs, id)
		}
	}
	articleContexts, err := s.loadArticleContexts(ctx, request.OrgID, processedItemIDs)
	if err != nil {
		return samplingQueryResponse{}, err
	}

	sourceIDsForMap := make([]string, 0, len(documents))
	for _, document := range documents {
		processedItemID := rawIDString(document.ID)
		if sourceID := rawString(document.SourceID); sourceID != nil {
			sourceIDsForMap = append(sourceIDsForMap, *sourceID)
		}
		if entry, ok := articleContexts[processedItemID]; ok && entry.SourceID != nil {
			sourceIDsForMap = append(sourceIDsForMap, *entry.SourceID)
		}
	}
	sourceMap, err := s.loadSourceMap(ctx, request.OrgID, sourceIDsForMap)
	if err != nil {
		return samplingQueryResponse{}, err
	}

	strataOrder := make([]string, 0, len(documents))
	strataMap := make(map[string][]classificationSampleItem)
	for _, document := range documents {
		processedItemID := rawIDString(document.ID)
		if processedItemID == "" {
			continue
		}
		result := document.Result
		confidence := rawConfidence(result.CategoryConfidence)
		if confidence == nil {
			continue
		}
		band := toConfidenceBand(*confidence)
		if len(bandFilter) > 0 && !containsString(bandFilter, string(band)) {
			continue
		}

		method := normalizeMethod(rawString(result.CategoryMethod))
		categoryPath := rawString(result.CategoryPath)
		sourceID := rawString(document.SourceID)
		articleContext := articleContexts[processedItemID]

		sourceInfoEntry, hasSourceInfo := sourceInfoFor(sourceID, articleContext, sourceMap)
		label := rawString(result.Source)
		var rawURL *string
		if hasSourceInfo {
			name := sourceInfoEntry.Name
			url := sourceInfoEntry.URL
			label = &name
			rawURL = &url
		} else if articleContext.ArticleURL != nil {
			rawURL = articleContext.ArticleURL
		}
		sourceType := classifySourceByLabelAndURL(label, rawURL, policy)
		if request.SourceType != nil && sourceType != *request.SourceType {
			continue
		}

		key := string(band) + "|" + method
		if _, ok := strataMap[key]; !ok {
			strataOrder = append(strataOrder, key)
		}
		sampledAt := time.Now().UTC()
		if parsed := rawTime(document.CreatedAt); parsed != nil {
			sampledAt = *parsed
		}
		resolvedSourceID := sourceID
		if resolvedSourceID == nil {
			resolvedSourceID = articleContext.SourceID
		}
		strataMap[key] = append(strataMap[key], classificationSampleItem{
			ProcessedItemID:         processedItemID,
			ItemMetaID:              rawString(document.ItemMetaID),
			SourceID:                resolvedSourceID,
			SourceType:              sourceType,
			ArticleURL:              articleContext.ArticleURL,
			ArticleTitle:            rawString(result.Title),
			PredictedCategoryPath:   categoryPath,
			PredictedLegacyCategory: rawString(result.Category),
			PredictedConfidence:     *confidence,
			PredictedMethod:         method,
			ConfidenceBand:          band,
			SampledAt:               sampledAt,
		})
	}

	selectedItems := make([]classificationSampleItem, 0, len(strataMap)*perStratum)
	strata := make([]classificationSampleStratum, 0, len(strataOrder))
	for _, key := range strataOrder {
		entries := strataMap[key]
		shuffleSampleItems(entries)
		strata = append(strata, classificationSampleStratum{Key: key, Count: len(entries)})
		limit := perStratum
		if len(entries) < limit {
			limit = len(entries)
		}
		selectedItems = append(selectedItems, entries[:limit]...)
	}

	sampleCollection, err := s.collection(samplesCollection)
	if err != nil {
		return samplingQueryResponse{}, err
	}
	sampleObjectID := bson.NewObjectID()
	createdAt := nowMillis()
	document := classificationSampleDocument{
		ID:          sampleObjectID,
		OrgID:       request.OrgID,
		CreatedByID: request.ActorID,
		Filters: classificationSampleFilters{
			Window:          request.Window,
			SourceType:      request.SourceType,
			SourceIDs:       stringSliceOrEmpty(sourceFilter),
			CategoryPrefix:  request.CategoryPrefix,
			ConfidenceBands: bandValues,
			Methods:         stringSliceOrEmpty(methodFilter),
		},
		Strata:    strata,
		ItemCount: len(selectedItems),
		Items:     selectedItems,
		ExpiresAt: expiryDate(sampleRetentionDays),
	}
	insertDocument := document
	insertDocument.CreatedAt = createdAt
	insertDocument.UpdatedAt = createdAt
	if _, err := sampleCollection.InsertOne(ctx, insertDocument); err != nil {
		return samplingQueryResponse{}, err
	}

	sampleID := sampleObjectID.Hex()
	return samplingQueryResponse{
		SampleID:  &sampleID,
		ItemCount: len(selectedItems),
		Strata:    strata,
		Items:     selectedItems,
		CreatedAt: formatJSTime(createdAt),
	}, nil
}

// SubmitAnnotations mirrors submitAnnotations including the ObjectId guard
// (defect 1) and the confusion matrix recomputation.
func (s *Service) SubmitAnnotations(ctx context.Context, request annotationsRequest) (annotationSubmissionResponse, error) {
	sampleID := strings.TrimSpace(request.SampleID)
	if sampleID == "" {
		return annotationSubmissionResponse{}, newStatus(400, "sampleId is required")
	}
	if !validObjectID(sampleID) {
		return annotationSubmissionResponse{}, newStatus(404, "Sample not found")
	}
	sampleObjectID, err := bson.ObjectIDFromHex(sampleID)
	if err != nil {
		return annotationSubmissionResponse{}, newStatus(404, "Sample not found")
	}

	collection, err := s.collection(samplesCollection)
	if err != nil {
		return annotationSubmissionResponse{}, err
	}
	var sample struct {
		Items []classificationSampleItem `bson:"items"`
	}
	if err := collection.FindOne(ctx, bson.D{
		{Key: "_id", Value: sampleObjectID},
		{Key: "orgId", Value: request.OrgID},
	}).Decode(&sample); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return annotationSubmissionResponse{}, newStatus(404, "Sample not found")
		}
		return annotationSubmissionResponse{}, err
	}

	sampleItems := make(map[string]classificationSampleItem, len(sample.Items))
	for _, item := range sample.Items {
		processedItemID := strings.TrimSpace(item.ProcessedItemID)
		if processedItemID == "" {
			continue
		}
		sampleItems[processedItemID] = item
	}

	annotations, err := s.collection(annotationsCollection)
	if err != nil {
		return annotationSubmissionResponse{}, err
	}
	updated := 0
	for _, annotation := range request.Annotations {
		processedItemID := strings.TrimSpace(annotation.ProcessedItemID)
		if processedItemID == "" {
			continue
		}
		humanCategoryPath := normalizePath(annotation.HumanCategoryPath)
		if humanCategoryPath == nil {
			continue
		}
		sampleItem, ok := sampleItems[processedItemID]
		if !ok {
			continue
		}

		now := nowMillis()
		// The upsert mirrors Mongoose timestamps: updatedAt on every write and
		// createdAt only when the annotation is inserted.
		update := bson.D{
			{Key: "$set", Value: bson.D{
				{Key: "annotatorId", Value: request.ActorID},
				{Key: "predictedCategoryPath", Value: sampleItem.PredictedCategoryPath},
				{Key: "predictedMethod", Value: sampleItem.PredictedMethod},
				{Key: "predictedConfidence", Value: sampleItem.PredictedConfidence},
				{Key: "humanCategoryPath", Value: *humanCategoryPath},
				{Key: "note", Value: normalizeText(derefString(annotation.Note), 500)},
				{Key: "quickTags", Value: normalizeQuickTags(annotation.QuickTags)},
				{Key: "updatedAt", Value: now},
			}},
			{Key: "$setOnInsert", Value: bson.D{
				{Key: "expiresAt", Value: expiryDate(annotationRetentionDays)},
				{Key: "createdAt", Value: now},
			}},
		}
		filter := bson.D{
			{Key: "orgId", Value: request.OrgID},
			{Key: "sampleId", Value: sampleID},
			{Key: "processedItemId", Value: processedItemID},
		}
		if _, err := annotations.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true)); err != nil {
			return annotationSubmissionResponse{}, err
		}
		updated++
	}

	metrics, err := s.computeSampleMetrics(ctx, request.OrgID, &sampleID)
	if err != nil {
		return annotationSubmissionResponse{}, err
	}
	return annotationSubmissionResponse{
		SampleID:         sampleID,
		Updated:          updated,
		Total:            metrics.Total,
		Correct:          metrics.Correct,
		Accuracy:         metrics.Accuracy,
		ConfusionMatrix:  metrics.ConfusionMatrix,
		ProblemPathPairs: metrics.ProblemPathPairs,
	}, nil
}

// computeSampleMetrics mirrors the private computeSampleMetrics helper.
func (s *Service) computeSampleMetrics(ctx context.Context, orgID string, sampleID *string) (sampleMetrics, error) {
	settings := s.qualitySettingsFor(ctx, orgID)
	collection, err := s.collection(annotationsCollection)
	if err != nil {
		return sampleMetrics{}, err
	}
	filter := bson.D{{Key: "orgId", Value: orgID}}
	if sampleID != nil {
		filter = append(filter, bson.E{Key: "sampleId", Value: *sampleID})
	}
	cursor, err := collection.Find(ctx, filter, options.Find().
		SetProjection(bson.D{
			{Key: "predictedCategoryPath", Value: 1},
			{Key: "humanCategoryPath", Value: 1},
		}))
	if err != nil {
		return sampleMetrics{}, err
	}
	var documents []annotationPairDocument
	if err := cursor.All(ctx, &documents); err != nil {
		return sampleMetrics{}, err
	}

	pairs := make([]confusionPair, 0, len(documents))
	for _, document := range documents {
		pairs = append(pairs, confusionPair{
			Predicted: rawString(document.PredictedCategoryPath),
			Actual:    rawString(document.HumanCategoryPath),
		})
	}
	return computeConfusionMetrics(pairs, settings), nil
}

// confusionPair is one annotated (predicted, actual) category path pair.
type confusionPair struct {
	Predicted *string
	Actual    *string
}

// computeConfusionMetrics mirrors the metric half of computeSampleMetrics: every
// annotation contributes to the confusion matrix, identical paths count as
// correct, and only pairs above both configured thresholds become problem pairs.
// The counting itself lives in confusionAccumulator so the aggregated report
// path (report_metrics.go) shares it.
func computeConfusionMetrics(pairs []confusionPair, settings qualitySettings) sampleMetrics {
	accumulator := newConfusionAccumulator(len(pairs))
	for _, pair := range pairs {
		accumulator.add(pair.Predicted, pair.Actual, 1)
	}
	return accumulator.metrics(settings)
}

// splitConfusionKey mirrors the NestJS destructuring of key.split("=>"): a path
// that itself contains "=>" is truncated at the first separator.
func splitConfusionKey(key string) (string, string) {
	parts := strings.Split(key, "=>")
	if len(parts) == 0 {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

// GetReportJob mirrors getReportJob. A missing job, or a jobId that is not a
// valid ObjectId, returns a nil response, which the handler serializes as JSON
// null with HTTP 200 (defect 1).
func (s *Service) GetReportJob(ctx context.Context, request reportJobRequest) (*reportJobResponse, error) {
	jobID := strings.TrimSpace(request.JobID)
	if !validObjectID(jobID) {
		return nil, nil
	}
	objectID, err := bson.ObjectIDFromHex(jobID)
	if err != nil {
		return nil, nil
	}

	collection, err := s.collection(reportJobsCollection)
	if err != nil {
		return nil, err
	}
	var job classificationReportJobDocument
	if err := collection.FindOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "orgId", Value: request.OrgID},
	}).Decode(&job); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}

	var result *classificationReportResultDocument
	if reportResultID := rawString(job.ReportResultID); reportResultID != nil {
		// The stored reference is written by the NestJS worker, so it must be a
		// valid ObjectId; anything else is corrupt data and stays a 500 rather
		// than being silently reported as a missing report.
		resultObjectID, err := bson.ObjectIDFromHex(*reportResultID)
		if err != nil {
			return nil, err
		}
		results, err := s.collection(reportResultsCollection)
		if err != nil {
			return nil, err
		}
		var stored classificationReportResultDocument
		if err := results.FindOne(ctx, bson.D{
			{Key: "_id", Value: resultObjectID},
			{Key: "orgId", Value: request.OrgID},
		}).Decode(&stored); err != nil {
			if !errors.Is(err, mongo.ErrNoDocuments) {
				return nil, err
			}
		} else {
			result = &stored
		}
	}

	progress := 0.0
	if parsed := rawNumber(job.Progress); parsed != nil {
		progress = math.Max(0, math.Min(1, *parsed))
	}
	createdAt := time.Now().UTC()
	if parsed := rawTime(job.CreatedAt); parsed != nil {
		createdAt = *parsed
	}
	updatedAt := time.Now().UTC()
	if parsed := rawTime(job.UpdatedAt); parsed != nil {
		updatedAt = *parsed
	}
	status := "pending"
	if parsed := rawString(job.Status); parsed != nil {
		status = *parsed
	}

	response := &reportJobResponse{
		Job: reportJobProgress{
			ID:          idPointer(rawIDString(job.ID)),
			Status:      status,
			SampleID:    rawString(job.SampleID),
			Progress:    progress,
			StartedAt:   isoPointer(rawTime(job.StartedAt)),
			CompletedAt: isoPointer(rawTime(job.CompletedAt)),
			Error:       reportJobErrorFromRaw(job.Error),
			CreatedAt:   formatJSTime(createdAt),
			UpdatedAt:   formatJSTime(updatedAt),
		},
	}
	if result != nil {
		total := 0.0
		if parsed := rawNumber(result.Total); parsed != nil {
			total = *parsed
		}
		correct := 0.0
		if parsed := rawNumber(result.Correct); parsed != nil {
			correct = *parsed
		}
		accuracy := 0.0
		if parsed := rawConfidence(result.Accuracy); parsed != nil {
			accuracy = *parsed
		}
		confusionMatrix := result.ConfusionMatrix
		if confusionMatrix == nil {
			confusionMatrix = []reportResultConfusionEntry{}
		}
		problemPathPairs := result.ProblemPathPairs
		if problemPathPairs == nil {
			problemPathPairs = []reportResultProblemPair{}
		}
		response.Result = &reportJobResult{
			ID:               idPointer(rawIDString(result.ID)),
			Total:            total,
			Correct:          correct,
			Accuracy:         accuracy,
			ConfusionMatrix:  confusionMatrix,
			ProblemPathPairs: problemPathPairs,
			Metadata:         reportResultMetadataFromRaw(result.Metadata),
		}
	}
	return response, nil
}

// reportJobErrorFromRaw decodes the Mixed error column into its only known shape.
func reportJobErrorFromRaw(value bson.RawValue) *classificationReportJobError {
	if value.Type != bson.TypeEmbeddedDocument {
		return nil
	}
	var document classificationReportJobError
	if err := value.Unmarshal(&document); err != nil {
		return nil
	}
	return &document
}

// reportResultMetadataFromRaw decodes the legacy Mixed metadata column.
func reportResultMetadataFromRaw(value bson.RawValue) *reportResultMetadata {
	if value.Type != bson.TypeEmbeddedDocument {
		return nil
	}
	return &reportResultMetadata{}
}

// idPointer returns nil for an empty id so the field serializes as null.
func idPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// isoPointer renders a time as the NestJS ISO string, or nil for null.
func isoPointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatJSTime(*value)
	return &formatted
}

// orderedSet trims, drops empties and deduplicates while preserving order.
func orderedSet(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// stringSliceOrEmpty returns an empty (non-nil) slice so JSON emits [].
func stringSliceOrEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// confidenceBandStrings converts the enum list for set membership checks.
func confidenceBandStrings(values []ConfidenceBand) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, string(value))
	}
	return out
}

// containsString reports membership in an ordered string slice.
func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// sourceInfoFor resolves the NewsSource row of a sample candidate.
func sourceInfoFor(sourceID *string, articleContext articleContext, sourceMap map[string]sourceInfo) (sourceInfo, bool) {
	if sourceID != nil {
		if entry, ok := sourceMap[*sourceID]; ok {
			return entry, true
		}
	}
	if articleContext.SourceID != nil {
		if entry, ok := sourceMap[*articleContext.SourceID]; ok {
			return entry, true
		}
	}
	return sourceInfo{}, false
}

// shuffleSampleItems mirrors the Fisher-Yates shuffle of the NestJS service.
// The input order is randomized per stratum, exactly like Math.random there.
func shuffleSampleItems(items []classificationSampleItem) {
	for index := len(items) - 1; index > 0; index-- {
		swap := rand.Intn(index + 1)
		items[index], items[swap] = items[swap], items[index]
	}
}

// derefString dereferences an optional string for helpers that take plain text.
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
