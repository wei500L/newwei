package newsnowhottest

import (
	"crypto/sha1"
	"encoding/hex"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Scoring weights and cache/TTL constants. Every value is copied from
// newsnow-hottest-analysis.utils.ts and newsnow-hottest-analysis.service.ts; a
// different weight would change candidate scores that the organization cache and
// the domestic opinion snapshots expose.
const (
	heatWeightRank        = 0.3
	heatWeightHeatValue   = 0.28
	heatWeightCrossSource = 0.27
	heatWeightAuthority   = 0.15

	candidateWeightHeatScore    = 0.34
	candidateWeightFreshness    = 0.24
	candidateWeightSupportScore = 0.24
	candidateWeightAuthority    = 0.1
	candidateWeightConfidence   = 0.08

	maxItemsPerSource               = 8
	maxTotalItems                   = 160
	maxLLMClusters                  = 16
	maxReturnedItems                = 160
	maxReturnedCandidates           = 8
	maxResolveItems                 = 96
	maxResolveCandidatesPerStage    = 20
	autoBridgeMaxItems              = 10
	autoBridgeConcurrency           = 3
	analysisFreshTTLSeconds         = 120
	analysisStaleTTLSeconds         = 600
	analysisLockTTLMillis           = 45_000
	analysisWaitTimeoutMillis       = 120_000
	analysisWaitInitialPoll         = 50
	analysisWaitMaxPoll             = 500
	globalSnapshotFreshTTLSeconds   = 2 * 60 * 60
	globalSnapshotStaleTTLSeconds   = 24 * 60 * 60
	globalSnapshotLockTTLMillis     = 45_000
	globalSnapshotWaitTimeoutMillis = 120_000
	globalSnapshotWaitInitialPoll   = 50
	globalSnapshotWaitMaxPoll       = 500
	signalStateTTLSeconds           = 36 * 60 * 60
	resolveConcurrency              = 6
	sourceFetchConcurrency          = 6
	candidateThreshold              = 0.36
	bridgeCandidateThreshold        = 0.52
	bridgeRankThreshold             = 3
	priorityRankThreshold           = 6
	maxPromptItemsPerCluster        = 5
	maxCandidateThemes              = 4
	maxCandidateEntities            = 8
	maxCandidateItemRefs            = 8
	maxPersistenceThemes            = 8
	maxPersistenceEntities          = 10
)

// autoBridgeSourceWhitelist is the set of sources whose entries may be turned
// into ItemMeta automatically.
var autoBridgeSourceWhitelist = map[string]bool{
	"wallstreetcn-hot": true,
	"cls-hot":          true,
	"thepaper":         true,
	"freebuf":          true,
	"sspai":            true,
	"juejin":           true,
	"ifeng":            true,
}

var (
	punctuationRunPattern = regexp.MustCompile(`[\p{P}\p{S}]+`)
	whitespaceRunPattern  = regexp.MustCompile(jsWhitespaceClass + `+`)
	latinTokenPattern     = regexp.MustCompile(`[a-z0-9]{2,}`)
	cjkSegmentPattern     = regexp.MustCompile(`[\x{3400}-\x{9fff}]{2,}`)
	heatPattern           = regexp.MustCompile(`(\d+(?:\.\d+)?)` + jsWhitespaceClass + `*(亿|萬|万|k|m|b)?`)
)

// localeCompare mirrors String.prototype.localeCompare with the default locale.
// The default is ICU root collation, which differs from byte comparison on
// punctuation, case and non-ASCII text. golang.org/x/text/collate is the root
// UCA implementation; the mutex keeps one collator usable from concurrent
// recommendation requests.
var (
	localeCompareMu sync.Mutex
	rootCollator    = collate.New(language.Und)
)

// localeCompare compares two strings with root collation.
func localeCompare(left, right string) int {
	localeCompareMu.Lock()
	defer localeCompareMu.Unlock()
	return rootCollator.CompareString(left, right)
}

// sha1Hex is node:crypto createHash("sha1").update(value, "utf8").digest("hex").
func sha1Hex(value string) string {
	sum := sha1.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// normalizeTitle trims, lowercases, replaces every punctuation/symbol run with a
// space and collapses whitespace. The JavaScript implementation uses Unicode
// property escapes and ECMAScript whitespace, both reproduced here.
func normalizeTitle(value string) string {
	trimmed := jsTrim(value)
	lowered := toLowerCase(trimmed)
	replaced := punctuationRunPattern.ReplaceAllString(lowered, " ")
	collapsed := whitespaceRunPattern.ReplaceAllString(replaced, " ")
	return jsTrim(collapsed)
}

// toLowerCase matches String.prototype.toLowerCase for the scripts hot-list
// titles use. It is Unicode-aware and locale independent. The only divergence is
// U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE): JavaScript maps it to "i" plus
// a combining dot, Go's simple mapping produces a single "i".
func toLowerCase(value string) string {
	return strings.ToLower(value)
}

// extractComparableTokens returns the latin words and CJK bigrams of a title.
// The result keeps first-seen order, like the JavaScript Set it replaces.
func extractComparableTokens(value string) []string {
	normalized := normalizeTitle(value)
	if normalized == "" {
		return []string{}
	}
	tokens := make([]string, 0, 16)
	seen := make(map[string]struct{}, 16)
	appendToken := func(token string) {
		if _, exists := seen[token]; exists {
			return
		}
		seen[token] = struct{}{}
		tokens = append(tokens, token)
	}
	for _, token := range latinTokenPattern.FindAllString(normalized, -1) {
		appendToken(token)
	}
	for _, segment := range cjkSegmentPattern.FindAllString(normalized, -1) {
		runes := []rune(segment)
		for index := 0; index < len(runes)-1; index++ {
			appendToken(string(runes[index : index+2]))
		}
	}
	return tokens
}

// computeTitleSimilarity is the union/bigram similarity used by the heuristic
// clustering. Lengths are UTF-16 code units, like String.prototype.length.
func computeTitleSimilarity(left, right string) float64 {
	normalizedLeft := normalizeTitle(left)
	normalizedRight := normalizeTitle(right)
	if normalizedLeft == "" || normalizedRight == "" {
		return 0
	}
	if normalizedLeft == normalizedRight {
		return 1
	}
	leftLength := jsLength(normalizedLeft)
	rightLength := jsLength(normalizedRight)
	if leftLength >= 8 && rightLength >= 8 &&
		(containsRunes(normalizedLeft, normalizedRight) || containsRunes(normalizedRight, normalizedLeft)) {
		minLength := leftLength
		maxLength := rightLength
		if minLength > maxLength {
			minLength, maxLength = maxLength, minLength
		}
		return clamp01(float64(minLength) / float64(maxLength))
	}
	leftTokens := extractComparableTokens(normalizedLeft)
	rightTokens := extractComparableTokens(normalizedRight)
	if len(leftTokens) == 0 || len(rightTokens) == 0 {
		return 0
	}
	rightSet := make(map[string]struct{}, len(rightTokens))
	for _, token := range rightTokens {
		rightSet[token] = struct{}{}
	}
	intersection := 0
	unionSet := make(map[string]struct{}, len(leftTokens)+len(rightTokens))
	for _, token := range leftTokens {
		unionSet[token] = struct{}{}
		if _, exists := rightSet[token]; exists {
			intersection++
		}
	}
	for _, token := range rightTokens {
		unionSet[token] = struct{}{}
	}
	if len(unionSet) == 0 {
		return 0
	}
	return clamp01(float64(intersection) / float64(len(unionSet)))
}

// containsRunes is String.prototype.includes on the two strings.
func containsRunes(haystack, needle string) bool {
	return len(needle) <= len(haystack) && indexOfRunes(haystack, needle) >= 0
}

// indexOfRunes is String.prototype.indexOf for a non-empty needle.
func indexOfRunes(haystack, needle string) int {
	if needle == "" {
		return 0
	}
	haystackRunes := []rune(haystack)
	needleRunes := []rune(needle)
	if len(needleRunes) > len(haystackRunes) {
		return -1
	}
	for start := 0; start+len(needleRunes) <= len(haystackRunes); start++ {
		matches := true
		for offset := range needleRunes {
			if haystackRunes[start+offset] != needleRunes[offset] {
				matches = false
				break
			}
		}
		if matches {
			return start
		}
	}
	return -1
}

// parseHeatValue extracts the largest numeric value with its optional unit. The
// unit set is the JavaScript regex: 亿/萬/万/k/m/b.
func parseHeatValue(value *string) *float64 {
	if value == nil {
		return nil
	}
	normalized := toLowerCase(replaceAllLiteral(*value, ",", ""))
	matches := heatPattern.FindAllStringSubmatch(normalized, -1)
	if len(matches) == 0 {
		return nil
	}
	var best *float64
	for _, match := range matches {
		numeric, err := strconv.ParseFloat(match[1], 64)
		if err != nil || math.IsNaN(numeric) || math.IsInf(numeric, 0) {
			continue
		}
		unit := ""
		if len(match) > 2 {
			unit = match[2]
		}
		multiplier := 1.0
		switch unit {
		case "亿":
			multiplier = 100_000_000
		case "万", "萬":
			multiplier = 10_000
		case "k":
			multiplier = 1_000
		case "m":
			multiplier = 1_000_000
		case "b":
			multiplier = 1_000_000_000
		}
		next := numeric * multiplier
		if best == nil || next > *best {
			value := next
			best = &value
		}
	}
	return best
}

// replaceAllLiteral is String.prototype.replaceAll with a plain string needle.
func replaceAllLiteral(value, needle, replacement string) string {
	if needle == "" {
		return value
	}
	return strings.ReplaceAll(value, needle, replacement)
}

// buildSignalKey hashes the source, normalized title and lowercase URL.
func buildSignalKey(sourceID, title, url string) string {
	return sha1Hex(sourceID + "|" + normalizeTitle(title) + "|" + toLowerCase(jsTrim(url)))
}

// SignatureItem is one item of the global signature payload.
type SignatureItem struct {
	ID       string
	Title    string
	URL      string
	HeatText *string
	Rank     int
}

// SignatureEntry is one source of the global signature payload.
type SignatureEntry struct {
	SourceID string
	Failed   bool
	Items    []SignatureItem
}

type signatureItemPayload struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	URL      string         `json:"url"`
	HeatText nullableString `json:"heatText"`
	Rank     int            `json:"rank"`
}

type signatureEntryPayload struct {
	SourceID string                 `json:"sourceId"`
	Failed   bool                   `json:"failed"`
	Items    []signatureItemPayload `json:"items"`
}

// buildGlobalInputSignature reproduces buildGlobalInputSignature: normalize every
// entry, sort items by rank then id then url, sort entries by source id, then
// sha1 the JSON payload. The order is part of the cross-process cache contract
// because the signature decides whether the cached snapshot is reused.
func buildGlobalInputSignature(entries []SignatureEntry) string {
	payload := make([]signatureEntryPayload, 0, len(entries))
	for _, entry := range entries {
		items := make([]signatureItemPayload, 0, len(entry.Items))
		for _, item := range entry.Items {
			items = append(items, signatureItemPayload{
				ID:       jsTrim(item.ID),
				Title:    normalizeTitle(item.Title),
				URL:      toLowerCase(jsTrim(item.URL)),
				HeatText: stringPtrOrNull(trimOptional(item.HeatText)),
				Rank:     item.Rank,
			})
		}
		sort.SliceStable(items, func(left, right int) bool {
			if items[left].Rank != items[right].Rank {
				return items[left].Rank < items[right].Rank
			}
			if items[left].ID != items[right].ID {
				return localeCompare(items[left].ID, items[right].ID) < 0
			}
			return localeCompare(items[left].URL, items[right].URL) < 0
		})
		payload = append(payload, signatureEntryPayload{
			SourceID: toLowerCase(jsTrim(entry.SourceID)),
			Failed:   entry.Failed,
			Items:    items,
		})
	}
	sort.SliceStable(payload, func(left, right int) bool {
		return localeCompare(payload[left].SourceID, payload[right].SourceID) < 0
	})
	encoded, err := marshalJSON(payload)
	if err != nil {
		// The payload contains only strings, booleans and integers; encoding
		// cannot fail. An empty signature would still be a deterministic value,
		// so return the hash of the empty object rather than panicking a request.
		encoded = []byte("[]")
	}
	return sha1Hex(string(encoded))
}

// trimOptional mirrors `value?.trim() ?? null` for an optional heat text.
func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	return &trimmed
}

// computeFreshness ports computeFreshness. An unknown or unparsable first-seen
// timestamp counts as twelve hours old, exactly like the JavaScript fallback.
func computeFreshness(nowMillis int64, state *SignalState, rank int) (freshnessScore float64, isNew bool, isRising bool) {
	if state == nil {
		return 1, true, false
	}
	firstSeenMillis := int64(0)
	parsed, ok := parseISOTime(state.FirstSeenAt)
	if ok {
		firstSeenMillis = parsed.UnixMilli()
	}
	ageMillis := float64(12 * 60 * 60 * 1000)
	if ok {
		ageMillis = math.Max(0, float64(nowMillis-firstSeenMillis))
	}
	ageHours := ageMillis / (60 * 60 * 1000)
	newness := 0.18
	switch {
	case ageHours <= 0.5:
		newness = 1
	case ageHours <= 2:
		newness = 0.82
	case ageHours <= 6:
		newness = 0.55
	case ageHours <= 12:
		newness = 0.35
	}
	previousRank := 0
	if state.LastRank.Valid {
		previousRank = int(state.LastRank.Value)
	}
	rankGain := 0
	if previousRank > 0 && previousRank > rank {
		rankGain = previousRank - rank
	}
	riseScore := 0.0
	if rankGain > 0 {
		riseScore = clamp01(float64(rankGain) / 12)
	}
	return clamp01(newness*0.7 + riseScore*0.3), false, rankGain > 0
}

// buildHeuristicClusters groups seeds whose titles are similar enough, then
// sorts clusters by breadth, peak heat and average rank.
func buildHeuristicClusters(signals []SignalSeed) []SignalCluster {
	if len(signals) == 0 {
		return []SignalCluster{}
	}
	parents := make([]int, len(signals))
	for index := range parents {
		parents[index] = index
	}
	var find func(int) int
	find = func(index int) int {
		if parents[index] != index {
			parents[index] = find(parents[index])
		}
		return parents[index]
	}
	union := func(left, right int) {
		leftRoot := find(left)
		rightRoot := find(right)
		if leftRoot != rightRoot {
			parents[rightRoot] = leftRoot
		}
	}
	for leftIndex := 0; leftIndex < len(signals); leftIndex++ {
		for rightIndex := leftIndex + 1; rightIndex < len(signals); rightIndex++ {
			left := signals[leftIndex]
			right := signals[rightIndex]
			similarity := computeTitleSimilarity(left.Title, right.Title)
			if similarity >= 0.72 {
				union(leftIndex, rightIndex)
				continue
			}
			if left.SourceID == right.SourceID {
				continue
			}
			if similarity >= 0.48 {
				union(leftIndex, rightIndex)
			}
		}
	}
	groupOrder := make([]int, 0, len(signals))
	groups := make(map[int][]SignalSeed, len(signals))
	for index, signal := range signals {
		root := find(index)
		if _, exists := groups[root]; !exists {
			groupOrder = append(groupOrder, root)
		}
		groups[root] = append(groups[root], signal)
	}
	clusters := make([]SignalCluster, 0, len(groupOrder))
	for _, root := range groupOrder {
		items := groups[root]
		representative := items[0]
		totalHeat := 0.0
		maxHeat := 0.0
		rankSum := 0
		sourceOrder := make([]string, 0, 4)
		sourceSeen := make(map[string]struct{}, 4)
		keys := make([]string, 0, len(items))
		for index, item := range items {
			if index == 0 || item.Rank < representative.Rank {
				representative = item
			}
			heat := item.HeatValue.OrZero()
			totalHeat += heat
			if heat > maxHeat {
				maxHeat = heat
			}
			rankSum += item.Rank
			if _, exists := sourceSeen[item.SourceID]; !exists {
				sourceSeen[item.SourceID] = struct{}{}
				sourceOrder = append(sourceOrder, item.SourceID)
			}
			keys = append(keys, item.SignalKey)
		}
		sortedKeys := append([]string(nil), keys...)
		sort.Strings(sortedKeys)
		clusterID := sha1Hex(joinPipe(sortedKeys))
		clusters = append(clusters, SignalCluster{
			ClusterID:           clusterID,
			ItemKeys:            keys,
			SourceIDs:           sourceOrder,
			RepresentativeTitle: representative.Title,
			TotalHeatValue:      totalHeat,
			MaxHeatValue:        maxHeat,
			AvgRank:             roundN(float64(rankSum)/float64(len(items)), 3),
		})
	}
	sort.SliceStable(clusters, func(left, right int) bool {
		if len(clusters[left].SourceIDs) != len(clusters[right].SourceIDs) {
			return len(clusters[left].SourceIDs) > len(clusters[right].SourceIDs)
		}
		if clusters[left].MaxHeatValue != clusters[right].MaxHeatValue {
			return clusters[left].MaxHeatValue > clusters[right].MaxHeatValue
		}
		return clusters[left].AvgRank < clusters[right].AvgRank
	})
	return clusters
}

// joinPipe joins strings with "|" without importing strings (kept local so the
// hot path allocates once).
func joinPipe(values []string) string {
	length := 0
	for _, value := range values {
		length += len(value)
	}
	if len(values) > 1 {
		length += len(values) - 1
	}
	buffer := make([]byte, 0, length)
	for index, value := range values {
		if index > 0 {
			buffer = append(buffer, '|')
		}
		buffer = append(buffer, value...)
	}
	return string(buffer)
}

// computeHeatScore ports computeHeatScore, including the JavaScript truthiness
// of heatValue: zero and null both produce a zero heat base.
func computeHeatScore(rank, rankCap int, heatValue *float64, maxHeatValue float64, sourceCount int, authority float64) float64 {
	rankBase := 1.0
	if rankCap > 1 {
		rankBase = 1 - float64(rank-1)/float64(rankCap-1)
	}
	heatBase := 0.0
	if heatValue != nil && *heatValue != 0 && maxHeatValue > 0 {
		heatBase = math.Sqrt(math.Min(*heatValue, maxHeatValue) / maxHeatValue)
	}
	crossSourceBase := clamp01(float64(sourceCount-1) / 4)
	return clamp01(rankBase*heatWeightRank +
		heatBase*heatWeightHeatValue +
		crossSourceBase*heatWeightCrossSource +
		clamp01(authority)*heatWeightAuthority)
}

// computeCandidateScore ports computeCandidateScore. confidence nil means the
// default 0.5 used when the model gave no usable confidence.
func computeCandidateScore(heatScore, freshnessScore float64, sourceCount int, authority float64, confidence *float64) float64 {
	supportScore := clamp01(float64(sourceCount-1) / 5)
	confidenceValue := 0.5
	if confidence != nil && !math.IsNaN(*confidence) && !math.IsInf(*confidence, 0) {
		confidenceValue = clamp01(*confidence)
	}
	return clamp01(heatScore*candidateWeightHeatScore +
		freshnessScore*candidateWeightFreshness +
		supportScore*candidateWeightSupportScore +
		clamp01(authority)*candidateWeightAuthority +
		confidenceValue*candidateWeightConfidence)
}

// clamp01 is Math.max(0, Math.min(1, Number(value.toFixed(4)))).
func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	clamped := math.Max(0, math.Min(1, value))
	return roundN(clamped, 4)
}

// roundN is Number(value.toFixed(digits)).
func roundN(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	parsed, err := strconv.ParseFloat(strconv.FormatFloat(value, 'f', digits, 64), 64)
	if err != nil {
		return 0
	}
	return parsed
}

// buildStateKey is the per-organization signal state Redis key.
func buildStateKey(orgID, signalKey string) string {
	return "newsnow:hottest:state:v1:" + orgID + ":" + signalKey
}

// buildAnalysisCacheKey is the fresh organization analysis key.
func buildAnalysisCacheKey(orgID string) string {
	return "newsnow:hottest:analysis:v1:" + orgID + ":fresh"
}

// buildAnalysisStaleCacheKey is the stale organization analysis key.
func buildAnalysisStaleCacheKey(orgID string) string {
	return "newsnow:hottest:analysis:v1:" + orgID + ":stale"
}

// buildGlobalSignatureCacheKey is the cached global input signature key.
func buildGlobalSignatureCacheKey() string {
	return "newsnow:hottest:global:v1:signature"
}

// buildGlobalSnapshotCacheKey is the fresh global snapshot key.
func buildGlobalSnapshotCacheKey() string {
	return "newsnow:hottest:global:v1:fresh"
}

// buildGlobalSnapshotStaleCacheKey is the stale global snapshot key.
func buildGlobalSnapshotStaleCacheKey() string {
	return "newsnow:hottest:global:v1:stale"
}

// buildBridgeExternalId is the deterministic ItemMeta external id of one bridged
// signal.
func buildBridgeExternalId(sourceID, url string) string {
	return "newsnow:" + sourceID + ":" + sha1Hex(toLowerCase(jsTrim(url)))
}

// resolveEmptyReason ports resolveHottestAnalysisEmptyReason.
func resolveEmptyReason(candidates []EventCandidate, diagnostics Diagnostics, itemsAnalyzed int) *EmptyReason {
	if len(candidates) > 0 {
		return nil
	}
	reason := EmptyNoCandidates
	switch {
	case diagnostics.SourcesRequested == 0:
		reason = EmptyNoHottestSourcesConfigured
	case diagnostics.SourcesSucceeded == 0 && diagnostics.SourcesFailed > 0:
		reason = EmptyAllSourcesFailed
	case diagnostics.SourceItemsFetched == 0:
		reason = EmptyNoSourceItems
	case itemsAnalyzed == 0:
		reason = EmptyNoHotSignals
	}
	return &reason
}

// resolveContentKind narrows a model-supplied string to the closed enum.
func resolveContentKind(value string) ContentKind {
	switch ContentKind(value) {
	case ContentArticle, ContentDiscussion, ContentVideo, ContentMixed:
		return ContentKind(value)
	default:
		return ContentUnknown
	}
}

// normalizeContentKindList deduplicates and trims entity names.
func normalizeEntityNames(entities []InsightEntity) []string {
	names := make([]string, 0, len(entities))
	seen := make(map[string]struct{}, len(entities))
	for _, entity := range entities {
		name := jsTrim(entity.Name)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

// uniqueStrings preserves first-seen order.
func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// firstN caps a slice without copying.
func firstN[T any](values []T, limit int) []T {
	if limit < 0 || len(values) <= limit {
		return values
	}
	return values[:limit]
}
