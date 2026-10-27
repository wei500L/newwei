package crawlfrontiernode

// discover.go ports the discovery half of the Frontier node chain:
//
//   - layeredExecutor.extractCandidates
//     (crawl-strategy-layered-executor.service.ts 169-581): link extraction,
//     URL resolution, the host/locale/utility filters, page-type inference,
//     freshness and URL scoring, the layered score threshold, prioritisation,
//     the max-children budget, every candidate decision trace and the
//     extraction diagnostics.
//   - crawl-frontier.service.ts discoverChildNodes (2980-3034).
//   - discoverSeedNodes (3036-3142).
//   - shouldQueueLlmJudge (3144-3157).
//   - estimateSeedCandidateFreshnessScore (2586-2613).
//   - discoverSitemapSeeds, the Go form of CrawlMetadataService.discoverSitemap
//     (crawl-metadata.service.ts 243) over crawlmetadata.Discovery.
//   - applyCandidateDiscoveryMetadata (2613-2659), delegated to the shared
//     materialize helper so the synthetic-list decision stays single-sourced.
//   - createPageTypeCountRecord (2548) is node-metadata's; resolveSeedStrategy
//     is crawlfrontierllm.ResolveSeedStrategyValue and resolveSeedDiscoveryConfig
//     belongs to node-branch (rootbranch.go).
//
// The final section of the file is a private port of the crawl-frontier.utils.ts
// helpers this slice calls. crawlfrontierllm does not export them yet, and the
// crawlstrategyruns copy drops the linkText argument, which would change both
// the page-type signals and the score. They are prefixed `frontier` so hoisting
// them into crawlfrontierllm later is a pure rename.

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
)

// discoverCandidateIndex is the JS Map<string, Candidate> extractCandidates dedupes
// with: a new key appends, an overwrite keeps the original position, so
// Array.from(byUrl.values()) yields insertion order.
type discoverCandidateIndex struct {
	order  []string
	values map[string]crawlfrontierllm.Candidate
}

// discoverNewCandidateIndex returns an empty ordered candidate map.
func discoverNewCandidateIndex() *discoverCandidateIndex {
	return &discoverCandidateIndex{values: map[string]crawlfrontierllm.Candidate{}}
}

// get is byUrl.get(key).
func (index *discoverCandidateIndex) get(key string) (crawlfrontierllm.Candidate, bool) {
	candidate, ok := index.values[key]
	return candidate, ok
}

// set is byUrl.set(key, candidate).
func (index *discoverCandidateIndex) set(key string, candidate crawlfrontierllm.Candidate) {
	if _, exists := index.values[key]; !exists {
		index.order = append(index.order, key)
	}
	index.values[key] = candidate
}

// len is byUrl.size.
func (index *discoverCandidateIndex) len() int { return len(index.order) }

// list is Array.from(byUrl.values()).
func (index *discoverCandidateIndex) list() []crawlfrontierllm.Candidate {
	out := make([]crawlfrontierllm.Candidate, 0, len(index.order))
	for _, key := range index.order {
		out = append(out, index.values[key])
	}
	return out
}

// extractCandidates ports layeredExecutor.extractCandidates (169-581).
//
// The NestJS method has no I/O: it walks the crawl4ai result links, drops the
// links the profile forbids, infers a page type and a score per candidate, keeps
// the best candidate per resolved URL, applies the layered score threshold and
// the max-children budget, and returns the candidates together with every
// decision trace the recorder must persist.
func (s *Service) extractCandidates(
	node *crawlfrontierllm.NodeRecord,
	config *crawlfrontierllm.Object,
	results []crawl4ai.PipelineArticle,
) candidateExtraction {
	byURL := discoverNewCandidateIndex()
	decisions := make([]crawlfrontierllm.CandidateDecision, 0)
	rejectionCounts := crawlfrontierllm.NewObject()
	sameDomainHost := frontierURLHostname(node.URL)
	// `requireSameDomainHost: sameDomainHost` is only truthy when the node URL
	// parsed; a falsy value disables the cross-domain rule entirely.
	var requireSameDomainHost *string
	if sameDomainHost != "" {
		requireSameDomainHost = stringPointer(sameDomainHost)
	}
	allowlist := crawlfrontierllm.ObjectStrings(config, "urlQueryParamAllowlist")
	selfCanonical := crawlfrontierllm.BuildCanonicalURLFingerprint(node.URL, allowlist)
	selfKey := node.URL
	if selfCanonical != nil {
		selfKey = selfCanonical.Fingerprint
	}
	scannedLinks := 0
	// buildBaseMetadata is buildBaseMetadata: the discovery provenance every
	// rejected decision carries, merged with the per-reason extras. A `null`
	// linkText is a real value (`linkText: linkText ?? null`).
	buildBaseMetadata := func(linkText *string, extra *crawlfrontierllm.Object) *crawlfrontierllm.Object {
		base := crawlfrontierllm.NewObjectFromPairs(
			"discoveredFromNodeId", node.ID,
			"discoveredFromPageType", node.PageType,
			"linkText", nullableStringValue(linkText),
		)
		merged := crawlfrontierllm.MergeObjects(base, extra)
		if merged == nil {
			return crawlfrontierllm.NewObject()
		}
		return merged
	}
	pushDecision := func(decision crawlfrontierllm.CandidateDecision) {
		decisions = append(decisions, decision)
	}
	// rejectFilteredURL appends one `nodeType: "url-filter"` decision with the
	// base metadata and the reason, then bumps the reason counter.
	rejectFilteredURL := func(rawURL string, linkText *string, extra *crawlfrontierllm.Object, reason, message string) {
		discoverBumpCount(rejectionCounts, reason)
		pushDecision(crawlfrontierllm.CandidateDecision{
			Candidate: crawlfrontierllm.Candidate{
				URL:      rawURL,
				Metadata: discoverMetadataRaw(buildBaseMetadata(linkText, extra)),
			},
			NodeType:       "url-filter",
			Action:         "filtered",
			Message:        message,
			Status:         "rejected",
			Accepted:       discoverAccepted(false),
			RejectedReason: stringPointer(reason),
			RuleHits:       []string{reason},
		})
	}

	for _, result := range results {
		baseURL := node.URL
		if trimmed := crawlfrontierllm.JsTrim(result.URL); trimmed != "" {
			baseURL = trimmed
		}
		// `for (const links of Object.values(result.links ?? {}))`: a missing or
		// non-object leaf contributes nothing, and only array values are walked.
		links, ok := crawlfrontierllm.ParseObject(result.Links)
		if !ok {
			continue
		}
		for _, group := range links.Keys() {
			rawGroup, _ := links.Raw(group)
			var entries []json.RawMessage
			if err := json.Unmarshal(rawGroup, &entries); err != nil {
				continue
			}
			for _, entry := range entries {
				link, ok := crawlfrontierllm.ParseObject(entry)
				if !ok {
					continue
				}
				href, present := discoverTrimmedString(link, "href")
				if !present {
					href, _ = discoverTrimmedString(link, "url")
				}
				linkText := discoverStringLeaf(link, "text")
				if linkText == nil {
					linkText = discoverStringLeaf(link, "title")
				}
				if href == "" {
					continue
				}
				scannedLinks++
				resolvedURL, resolveOK := frontierResolveLink(href, baseURL)
				if !resolveOK {
					rejectFilteredURL(href, linkText, crawlfrontierllm.NewObjectFromPairs(
						"baseUrl", baseURL,
						"invalidHref", href,
					), "invalid_url", "Rejected link because the href could not be resolved into a valid URL")
					continue
				}
				if resolvedURL == node.URL {
					rejectFilteredURL(resolvedURL, linkText, crawlfrontierllm.NewObjectFromPairs(
						"baseUrl", baseURL,
					), "self_url", "Rejected self-referential link during layered extraction")
					continue
				}
				if frontierIsUtilityLinkText(linkText) {
					rejectFilteredURL(resolvedURL, linkText, crawlfrontierllm.NewObjectFromPairs(
						"baseUrl", baseURL,
					), "utility_link_text", "Rejected utility navigation link during layered extraction")
					continue
				}
				if rejectionReason := frontierShouldRejectURL(frontierRejectURLOptions{
					URL:                   resolvedURL,
					Config:                config,
					RequireSameDomainHost: requireSameDomainHost,
					LinkText:              linkText,
				}); rejectionReason != nil {
					rejectFilteredURL(resolvedURL, linkText, crawlfrontierllm.NewObjectFromPairs(
						"baseUrl", baseURL,
					), *rejectionReason, "Rejected URL during layered filtering: "+*rejectionReason)
					continue
				}
				candidateCanonical := crawlfrontierllm.BuildCanonicalURLFingerprint(resolvedURL, allowlist)
				candidateKey := resolvedURL
				if candidateCanonical != nil {
					candidateKey = candidateCanonical.Fingerprint
				}
				if candidateKey == selfKey {
					extra := crawlfrontierllm.NewObjectFromPairs("baseUrl", baseURL)
					extra.SetNull("canonicalUrl")
					extra.SetNull("urlFingerprint")
					if candidateCanonical != nil {
						extra.SetString("canonicalUrl", candidateCanonical.CanonicalURL)
						extra.SetString("urlFingerprint", candidateCanonical.Fingerprint)
					}
					rejectFilteredURL(resolvedURL, linkText, extra, "self_canonical",
						"Rejected link because it canonicalized back to the current frontier node")
					continue
				}

				pageType := frontierInferPageType(frontierPageTypeOptions{
					URL:            resolvedURL,
					ParentPageType: node.PageType,
					Config:         config,
					LinkText:       linkText,
				})
				freshnessScore := frontierEstimateFreshnessScore(resolvedURL, config, s.now())
				rawScore := discoverLinkRawScore(link)
				score := frontierScoreCandidate(frontierScoreOptions{
					URL:            resolvedURL,
					PageType:       pageType,
					ParentPageType: node.PageType,
					ParentURL:      node.URL,
					Config:         config,
					RawScore:       rawScore,
					LinkText:       linkText,
					FreshnessScore: floatPointer(freshnessScore),
				})
				candidate := crawlfrontierllm.Candidate{
					URL:            resolvedURL,
					PageType:       pageType,
					Score:          score,
					FreshnessScore: freshnessScore,
					Metadata: discoverMetadataRaw(crawlfrontierllm.NewObjectFromPairs(
						"discoveredFromNodeId", node.ID,
						"discoveredFromPageType", node.PageType,
						"linkText", nullableStringValue(linkText),
						"frontierScore", score,
						"frontierFreshnessScore", freshnessScore,
					)),
				}
				baseSnapshot := discoverEmptySnapshot(candidate.URL, "active")
				classifiedSnapshot := crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
					URL:      candidate.URL,
					PageType: pageType,
					Status:   "active",
				})
				freshnessSnapshot := crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
					URL:            candidate.URL,
					PageType:       pageType,
					FreshnessScore: floatPointer(freshnessScore),
					Status:         "active",
				})
				scoredSnapshot := discoverScoredSnapshot(candidate)
				pushDecision(crawlfrontierllm.CandidateDecision{
					Candidate:      candidate,
					NodeType:       "page-type-classifier",
					Action:         "classified",
					Message:        "Classified candidate as " + pageType,
					Status:         "active",
					Accepted:       discoverAccepted(true),
					BeforeSnapshot: baseSnapshot,
					AfterSnapshot:  classifiedSnapshot,
					Details:        crawlfrontierllm.NewObjectFromPairs("pageType", pageType),
				})
				pushDecision(crawlfrontierllm.CandidateDecision{
					Candidate:      candidate,
					NodeType:       "freshness-scorer",
					Action:         "scored",
					Message:        "Layered freshness 0.000 -> " + discoverFixedDecimal(freshnessScore, 3),
					Status:         "active",
					Accepted:       discoverAccepted(true),
					BeforeSnapshot: classifiedSnapshot,
					AfterSnapshot:  freshnessSnapshot,
					FreshnessDelta: floatPointer(crawlfrontierllm.RoundToFixed(freshnessScore, 4)),
					RuleHits:       []string{"freshness_scored"},
				})
				pushDecision(crawlfrontierllm.CandidateDecision{
					Candidate:      candidate,
					NodeType:       "url-scorer",
					Action:         "scored",
					Message:        "Layered score 0.000 -> " + discoverFixedDecimal(score, 3),
					Status:         "active",
					Accepted:       discoverAccepted(true),
					BeforeSnapshot: freshnessSnapshot,
					AfterSnapshot:  scoredSnapshot,
					ScoreDelta:     floatPointer(crawlfrontierllm.RoundToFixed(score, 4)),
					RuleHits:       []string{"url_scored"},
				})
				existing, ok := byURL.get(resolvedURL)
				if !ok || score > existing.Score {
					byURL.set(resolvedURL, candidate)
				}
			}
		}
	}

	threshold := 0.35
	if layered, ok := config.Object("layeredOptions"); ok {
		if value, ok := layered.Number("scoreThreshold"); ok {
			threshold = value
		}
	}
	accepted := make([]crawlfrontierllm.Candidate, 0, byURL.len())
	lowScoreCandidates := make([]crawlfrontierllm.Candidate, 0)
	for _, candidate := range byURL.list() {
		if candidate.Score >= threshold {
			accepted = append(accepted, candidate)
			continue
		}
		lowScoreCandidates = append(lowScoreCandidates, candidate)
	}
	lowScoreCount := byURL.len() - len(accepted)
	if lowScoreCount < 0 {
		lowScoreCount = 0
	}
	if lowScoreCount > 0 {
		rejectionCounts.SetNumber("low_score", float64(lowScoreCount))
		for _, candidate := range lowScoreCandidates {
			pushDecision(crawlfrontierllm.CandidateDecision{
				Candidate:      candidate,
				NodeType:       "budget-control",
				Action:         "budgeted",
				Message:        "Rejected candidate because layered discovery score was below the threshold",
				Status:         "rejected",
				Accepted:       discoverAccepted(false),
				RejectedReason: stringPointer("low_score"),
				RuleHits:       []string{"low_score"},
				BeforeSnapshot: discoverScoredSnapshot(candidate),
				AfterSnapshot: crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
					URL:            candidate.URL,
					PageType:       candidate.PageType,
					Score:          floatPointer(candidate.Score),
					FreshnessScore: floatPointer(candidate.FreshnessScore),
					Status:         "rejected",
					RejectedReason: stringPointer("low_score"),
				}),
				Details: crawlfrontierllm.NewObjectFromPairs("scoreThreshold", threshold),
			})
		}
	}

	acceptedPageTypeCounts := createPageTypeCountRecord()
	for _, candidate := range accepted {
		discoverIncrementPageType(acceptedPageTypeCounts, candidate.PageType)
	}

	prioritized := crawlfrontierllm.PrioritizeCandidates(node.PageType, accepted)
	maxChildren := 24
	if layered, ok := config.Object("layeredOptions"); ok {
		if value, ok := layered.Number("maxChildrenPerNode"); ok {
			maxChildren = int(value)
		}
	}
	trimmed := len(prioritized) - maxChildren
	if trimmed < 0 {
		trimmed = 0
	}
	if trimmed > 0 {
		rejectionCounts.SetNumber("max_children_trimmed", float64(trimmed))
		for index, candidate := range prioritized[maxChildren:] {
			pushDecision(crawlfrontierllm.CandidateDecision{
				Candidate:      candidate,
				NodeType:       "budget-control",
				Action:         "budgeted",
				Message:        "Rejected candidate because it fell outside the layered max children budget",
				Status:         "rejected",
				Accepted:       discoverAccepted(false),
				RejectedReason: stringPointer("max_children_trimmed"),
				RuleHits:       []string{"max_children_trimmed"},
				BeforeSnapshot: discoverScoredSnapshot(candidate),
				AfterSnapshot: crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
					URL:            candidate.URL,
					PageType:       candidate.PageType,
					Score:          floatPointer(candidate.Score),
					FreshnessScore: floatPointer(candidate.FreshnessScore),
					Status:         "rejected",
					RejectedReason: stringPointer("max_children_trimmed"),
				}),
				Details: crawlfrontierllm.NewObjectFromPairs(
					"maxChildren", maxChildren,
					"trimmedRank", maxChildren+index+1,
				),
			})
		}
	}
	selectedEnd := maxChildren
	if selectedEnd > len(prioritized) {
		selectedEnd = len(prioritized)
	}
	candidates := prioritized[:selectedEnd]
	for _, candidate := range candidates {
		snapshot := discoverScoredSnapshot(candidate)
		pushDecision(crawlfrontierllm.CandidateDecision{
			Candidate:      candidate,
			NodeType:       "list-discovery",
			Action:         "discovered",
			Message:        "Candidate passed layered extraction filters and entered discovery flow",
			Status:         "active",
			Accepted:       discoverAccepted(true),
			RuleHits:       []string{"layered_candidate_selected"},
			BeforeSnapshot: snapshot,
			AfterSnapshot:  discoverScoredSnapshot(candidate),
			Details: crawlfrontierllm.NewObjectFromPairs(
				"scoreThreshold", threshold,
				"maxChildren", maxChildren,
			),
		})
	}

	diagnostics := crawlfrontierllm.NewObject()
	diagnostics.SetRaw("candidateStats", discoverCandidateStatsObject(discoverCandidateStats{
		Scanned:  scannedLinks,
		Unique:   byURL.len(),
		Accepted: len(accepted),
		Selected: len(candidates),
		Rejected: discoverRejectionTotal(rejectionCounts),
		Trimmed:  trimmed,
	}))
	diagnostics.SetRaw("rejectionCounts", discoverMetadataRaw(rejectionCounts))
	diagnostics.SetRaw("acceptedPageTypeCounts", discoverMetadataRaw(acceptedPageTypeCounts))
	diagnostics.Set("warningFlags", []string{})
	diagnostics.SetBool("syntheticListActivated", false)

	return candidateExtraction{
		Candidates:  candidates,
		Decisions:   decisions,
		Diagnostics: diagnostics,
	}
}

// discoverCandidateStats is the extraction candidateStats record.
type discoverCandidateStats struct {
	Scanned  int
	Unique   int
	Accepted int
	Selected int
	Rejected int
	Trimmed  int
}

// discoverCandidateStatsObject renders candidateStats in the NestJS key order.
func discoverCandidateStatsObject(stats discoverCandidateStats) json.RawMessage {
	return discoverMetadataRaw(crawlfrontierllm.NewObjectFromPairs(
		"scanned", stats.Scanned,
		"unique", stats.Unique,
		"accepted", stats.Accepted,
		"selected", stats.Selected,
		"rejected", stats.Rejected,
		"trimmed", stats.Trimmed,
	))
}

// discoverScoredSnapshot is buildCandidateSnapshot({...candidate, status,
// rejectedReason}): the candidate's own page type, score and freshness with the
// requested trace status.
func discoverScoredSnapshot(candidate crawlfrontierllm.Candidate) *crawlfrontierllm.Object {
	return crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
		URL:            candidate.URL,
		PageType:       candidate.PageType,
		Score:          floatPointer(candidate.Score),
		FreshnessScore: floatPointer(candidate.FreshnessScore),
		Status:         "active",
	})
}

// discoverEmptySnapshot is buildCandidateSnapshot with every scoring field
// explicitly null, which is the shape of the pre-classification snapshot
// (`pageType: null, score: null, freshnessScore: null, relevanceScore: null`).
// crawlfrontierllm.CandidateSnapshot carries a non-pointer PageType, so the
// shared helper cannot express the null this trace expects.
func discoverEmptySnapshot(rawURL, status string) *crawlfrontierllm.Object {
	return crawlfrontierllm.NewObjectFromPairs(
		"url", rawURL,
		"pageType", nil,
		"score", nil,
		"freshnessScore", nil,
		"relevanceScore", nil,
		"status", status,
		"rejectedReason", nil,
	)
}

// discoverMetadataRaw encodes a candidate metadata leaf. A failed encode becomes
// the empty object the trace recorder can still store.
func discoverMetadataRaw(object *crawlfrontierllm.Object) json.RawMessage {
	encoded, err := crawlfrontierllm.MustJSONRaw(object)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

// discoverAccepted boxes the decision `accepted` flag.
func discoverAccepted(value bool) *bool { return &value }

// discoverBumpCount is bumpCount on the rejectionCounts record: the key keeps
// its first position and the value is the occurrence count.
func discoverBumpCount(counts *crawlfrontierllm.Object, reason string) {
	current, ok := counts.Number(reason)
	if !ok {
		current = 0
	}
	counts.SetNumber(reason, current+1)
}

// discoverRejectionTotal is
// Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0).
func discoverRejectionTotal(counts *crawlfrontierllm.Object) int {
	total := 0
	for _, key := range counts.Keys() {
		if value, ok := counts.Number(key); ok {
			total += int(value)
		}
	}
	return total
}

// discoverIncrementPageType is `counts[pageType] += 1` for a known page type.
func discoverIncrementPageType(counts *crawlfrontierllm.Object, pageType string) {
	current, ok := counts.Number(pageType)
	if !ok {
		return
	}
	counts.SetNumber(pageType, current+1)
}

// discoverLinkRawScore is rawScore's nullish chain over the crawl4ai link scores: the
// first field that is a number wins, otherwise 0.
func discoverLinkRawScore(link *crawlfrontierllm.Object) float64 {
	for _, key := range []string{
		"totalScore",
		"total_score",
		"contextualScore",
		"contextual_score",
		"intrinsicScore",
		"intrinsic_score",
	} {
		if value, ok := discoverNumberField(link, key); ok {
			return value
		}
	}
	return 0
}

// discoverNumberField is `typeof link[key] === "number"`: a JSON number leaf. `null`
// and every non-number leaf are absent.
func discoverNumberField(object *crawlfrontierllm.Object, key string) (float64, bool) {
	raw, ok := object.Raw(key)
	if !ok {
		return 0, false
	}
	if trimmed := strings.TrimSpace(string(raw)); trimmed == "null" || trimmed == "" {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// discoverStringLeaf is `typeof value === "string" ? value : undefined`: a JSON
// string leaf, untrimmed. `null`, a number and a missing key are all absent,
// which is what the href/text/title chains branch on.
func discoverStringLeaf(object *crawlfrontierllm.Object, key string) *string {
	raw, ok := object.Raw(key)
	if !ok {
		return nil
	}
	if trimmed := strings.TrimSpace(string(raw)); len(trimmed) < 2 || trimmed[0] != '"' {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

// discoverTrimmedString is `typeof link[key] === "string" ? link[key].trim() : …`:
// the presence flag tells the caller whether the key was a string at all, so an
// empty string does not fall through to the next key.
func discoverTrimmedString(object *crawlfrontierllm.Object, key string) (string, bool) {
	value := discoverStringLeaf(object, key)
	if value == nil {
		return "", false
	}
	return crawlfrontierllm.JsTrim(*value), true
}

// discoverFixedDecimal is Number.prototype.toFixed(digits) rendered as text for the
// decision messages ("Layered score 0.000 -> 0.750"). The rounding goes through
// the shared toFixed helper first so the text and the numeric delta agree.
func discoverFixedDecimal(value float64, digits int) string {
	return strconv.FormatFloat(crawlfrontierllm.RoundToFixed(value, digits), 'f', digits, 64)
}

// extractFrontierNodeCandidates ports CrawlFrontierService.extractCandidates
// (crawl-frontier.service.ts 3508-3545), the wrapper discoverChildNodes calls
// instead of the layered extractCandidates above.
//
// The wrapper is what stamps the discovery provenance onto every candidate the
// node chain stores: sourceTier, freshnessBucket, the synthetic-list marking
// (syntheticList/syntheticListLabel) and the discoveryPath/frontierPath pair.
// It also rewrites the extraction diagnostics — the selected counter, the
// synthetic_list_activated warning flag and the syntheticListActivated member —
// and replaces the candidate embedded in every decision trace with the stamped
// one, so the persisted node metadata, the deferred judge payload and the
// workflow trace all carry the same object. The layered extractCandidates stays
// provenance free because the seed branch and the judge share it.
func (s *Service) extractFrontierNodeCandidates(
	node *crawlfrontierllm.NodeRecord,
	config *crawlfrontierllm.Object,
	results []crawl4ai.PipelineArticle,
) candidateExtraction {
	extraction := s.extractCandidates(node, config, results)
	candidates, syntheticListActivated := s.applyCandidateDiscoveryMetadata(node, config, extraction.Candidates)

	// const candidateByUrl = new Map(withDiscoveryMetadata.candidates.map(
	//   candidate => [candidate.url, candidate]));
	// decisions: extraction.decisions.map(decision => ({...decision,
	//   candidate: candidateByUrl.get(decision.candidate.url) ?? decision.candidate}))
	// A url-filter decision names a raw href that never became a candidate, so it
	// keeps its own object.
	candidateByURL := make(map[string]crawlfrontierllm.Candidate, len(candidates))
	for _, candidate := range candidates {
		candidateByURL[candidate.URL] = candidate
	}
	decisions := make([]crawlfrontierllm.CandidateDecision, len(extraction.Decisions))
	for index, decision := range extraction.Decisions {
		if candidate, ok := candidateByURL[decision.Candidate.URL]; ok {
			decision.Candidate = candidate
		}
		decisions[index] = decision
	}

	// The diagnostics object keeps the extraction key order; the three members
	// the wrapper recomputes are replaced in place, which Object.Set does.
	diagnostics := extraction.Diagnostics
	if diagnostics == nil {
		diagnostics = crawlfrontierllm.NewObject()
	} else {
		diagnostics = diagnostics.Clone()
	}
	candidateStats, ok := diagnostics.Object("candidateStats")
	if !ok || candidateStats == nil {
		candidateStats = crawlfrontierllm.NewObject()
	} else {
		candidateStats = candidateStats.Clone()
	}
	candidateStats.SetNumber("selected", float64(len(candidates)))
	diagnostics.Set("candidateStats", candidateStats)

	// uniqueStringList(
	//   extraction.diagnostics.warningFlags,
	//   syntheticListActivated ? ["synthetic_list_activated"] : undefined) ?? []
	var syntheticFlags []string
	if syntheticListActivated {
		syntheticFlags = []string{"synthetic_list_activated"}
	}
	warningFlags := crawlfrontierllm.UniqueStringList(
		crawlfrontierllm.ObjectStrings(diagnostics, "warningFlags"),
		syntheticFlags,
	)
	if warningFlags == nil {
		warningFlags = []string{}
	}
	diagnostics.Set("warningFlags", warningFlags)
	diagnostics.SetBool("syntheticListActivated", syntheticListActivated)

	return candidateExtraction{
		Candidates:  candidates,
		Decisions:   decisions,
		Diagnostics: diagnostics,
	}
}

// discoverChildNodes ports crawl-frontier.service.ts discoverChildNodes
// (2980-3034): resolve the workflow run, extract the candidates, record the
// extraction decisions, then either hand the candidates to the deferred LLM
// judge or materialize them directly.
func (s *Service) discoverChildNodes(ctx context.Context, input discoverChildNodesInput) (*crawlfrontierllm.Object, error) {
	workflowRunID, err := s.resolveWorkflowRunID(ctx, input.RunID)
	if err != nil {
		return nil, err
	}
	var config *crawlfrontierllm.Object
	if input.Profile != nil {
		config = input.Profile.Config
	}
	extraction := s.extractFrontierNodeCandidates(input.Node, config, input.Results)
	if err := s.recordExtractionCandidateDecisions(ctx, workflowRunID, input.Node.ID, extraction.Decisions); err != nil {
		return nil, err
	}
	if s.shouldQueueLlmJudge(input.Node, input.Profile, extraction.Candidates) {
		return s.deferLlmJudgeForDiscovery(ctx, deferJudgeDiscoveryInput{
			Node:                  input.Node,
			RunID:                 input.RunID,
			TaskID:                input.TaskID,
			MaxDepth:              input.MaxDepth,
			MaxPages:              input.MaxPages,
			Profile:               input.Profile,
			Candidates:            extraction.Candidates,
			ExtractionDiagnostics: extraction.Diagnostics,
			WorkflowRunID:         workflowRunID,
			MaxDepthOverride:      input.MaxDepthOverride,
			MaxNewNodes:           input.MaxNewNodes,
			MetadataPatch:         input.MetadataPatch,
		})
	}
	return s.frontier.DiscoverMaterialize(ctx, crawlfrontierllm.DiscoverMaterializeOptions{
		WorkflowRunID:         workflowRunID,
		Node:                  input.Node,
		RunID:                 input.RunID,
		TaskID:                input.TaskID,
		MaxDepth:              input.MaxDepth,
		MaxPages:              input.MaxPages,
		Profile:               input.Profile,
		Candidates:            extraction.Candidates,
		ExtractionDiagnostics: extraction.Diagnostics,
		MaxDepthOverride:      input.MaxDepthOverride,
		MaxNewNodes:           input.MaxNewNodes,
		MetadataPatch:         input.MetadataPatch,
	})
}

// discoverSeedNodes ports crawl-frontier.service.ts discoverSeedNodes
// (3036-3142). Only the root node of a run whose seed strategy is not
// `frontier_only` discovers seeds; every other node returns nil, which the root
// branch records as "no seed discovery".
func (s *Service) discoverSeedNodes(ctx context.Context, input discoverSeedNodesInput) (*seedDiscoveryOutcome, error) {
	var config *crawlfrontierllm.Object
	if input.Profile != nil {
		config = input.Profile.Config
	}
	if input.Node.Depth != 0 || crawlfrontierllm.ResolveSeedStrategyValue(config) == "frontier_only" {
		return nil, nil
	}
	seedConfig := s.resolveSeedDiscoveryConfig(config, input.Run.MaxPages, input.Run.MaxDepth)
	// `Date.now() - freshnessWindowHours * 60 * 60 * 1000`.
	freshnessCutoffTs := s.now().UnixMilli() - int64(seedConfig.FreshnessWindowHours*60*60*1000)
	origin, ok := frontierURLOrigin(input.Run.SeedURL)
	if !ok {
		return nil, newBadRequestError(discoverMessageInvalidURL)
	}
	var requestTimeoutMs *int
	if input.RequestTimeoutMs > 0 {
		requestTimeoutMs = intPointer(input.RequestTimeoutMs)
	}
	sitemap, err := s.discoverSitemapSeeds(ctx, sitemapSeedInput{
		Domain:            origin,
		MaxURLs:           seedConfig.MaxSeedURLs,
		RequestTimeoutMs:  requestTimeoutMs,
		FreshnessCutoffTs: freshnessCutoffTs,
		DiscoveryMode:     seedConfig.Mode,
	})
	if err != nil {
		return nil, err
	}
	if sitemap == nil {
		sitemap = &sitemapSeedResult{}
	}
	// `sitemap.diagnostics && isPlainObject(sitemap.diagnostics) ?
	// sitemap.diagnostics : {}`.
	diagnostics := sitemap.Diagnostics
	if diagnostics == nil {
		diagnostics = crawlfrontierllm.NewObject()
	}
	var seedMethod *string
	if value, ok := diagnostics.String("seedMethod"); ok {
		seedMethod = stringPointer(value)
	}
	discoveredCount := len(sitemap.Candidates)
	seedCandidates := make([]crawlfrontierllm.Candidate, 0, discoveredCount)
	for _, candidate := range sitemap.Candidates {
		pageType := frontierInferPageType(frontierPageTypeOptions{
			URL:            candidate.URL,
			ParentPageType: "home",
			Config:         config,
			PublishedAtTs:  candidate.PublishedAtTs,
		})
		freshnessScore := s.estimateSeedCandidateFreshnessScore(candidate, config)
		score := frontierScoreCandidate(frontierScoreOptions{
			URL:            candidate.URL,
			PageType:       pageType,
			ParentPageType: "home",
			ParentURL:      input.Run.SeedURL,
			Config:         config,
			RawScore:       1,
			FreshnessScore: floatPointer(freshnessScore),
		})
		if pageType == "home" {
			continue
		}
		seedCandidates = append(seedCandidates, crawlfrontierllm.Candidate{
			URL:            candidate.URL,
			PageType:       pageType,
			Score:          score,
			FreshnessScore: freshnessScore,
			Metadata: discoverMetadataRaw(crawlfrontierllm.NewObjectFromPairs(
				"seedCandidate", true,
				"seedOrigin", "sitemap",
				"seedMethod", nullableStringValue(seedMethod),
				"seedPublishedAt", discoverISOStringOrNull(candidate.PublishedAtTs),
				"seedCrawledAt", discoverISOStringOrNull(candidate.CrawledAtTs),
				"freshnessBucket", crawlfrontierllm.ResolveFreshnessBucket(freshnessScore),
			)),
		})
	}

	if s.shouldQueueLlmJudge(input.Node, input.Profile, seedCandidates) {
		return s.deferLlmJudgeForSeed(ctx, deferJudgeSeedInput{
			Node:               input.Node,
			Run:                input.Run,
			TaskID:             input.TaskID,
			Profile:            input.Profile,
			Candidates:         seedCandidates,
			DiscoveredCount:    discoveredCount,
			SeedConfig:         seedConfig,
			SitemapDiagnostics: diagnostics,
		})
	}
	workflowRunID, err := s.resolveWorkflowRunID(ctx, input.Run.ID)
	if err != nil {
		return nil, err
	}
	outcome, err := s.frontier.SeedMaterialize(ctx, crawlfrontierllm.SeedMaterializeOptions{
		WorkflowRunID: workflowRunID,
		Node:          input.Node,
		Run: crawlfrontierllm.SeedRun{
			ID:       input.Run.ID,
			SeedURL:  input.Run.SeedURL,
			MaxDepth: input.Run.MaxDepth,
			MaxPages: input.Run.MaxPages,
		},
		TaskID:             input.TaskID,
		Profile:            input.Profile,
		Candidates:         seedCandidates,
		SitemapDiagnostics: diagnostics,
		QualityThresholds:  seedConfig.QualityThresholds,
		DiscoveredCount:    discoveredCount,
	})
	if err != nil {
		return nil, err
	}
	return &seedDiscoveryOutcome{
		Created:                outcome.Created,
		SelectedPageTypeCounts: outcome.PageTypeCount,
		Diagnostics:            outcome.Diagnostics,
	}, nil
}

// sitemapSeedInput is discoverSitemap's argument object
// (crawl-metadata.service.ts 243): {domain, maxUrls, requestTimeoutMs?,
// freshnessCutoffTs?, discoveryMode?}.
type sitemapSeedInput struct {
	Domain            string
	MaxURLs           int
	RequestTimeoutMs  *int
	FreshnessCutoffTs int64
	DiscoveryMode     string
}

// sitemapSeedResult is CrawlSitemapDiscoveryResult (:173-176): the candidates
// plus the diagnostics the seed materializer and the deferred seed payload
// record.
type sitemapSeedResult struct {
	Candidates  []crawlmetadata.DiscoveryCandidate
	Diagnostics *crawlfrontierllm.Object
}

// discoverSitemapSeeds is the sitemap discovery entry point of this slice. It
// wraps crawlmetadata.Discovery.DiscoverSitemapSeedCandidates
// (crawlmetadata/discover_seed.go:16), which is the only Go path that returns the
// publish timestamps the seed freshness window and the candidate metadata need.
//
// Three NestJS inputs have no Go equivalent yet, so they are accepted but not
// forwarded:
//   - RequestTimeoutMs: crawlmetadata uses the shared settings timeout
//     (normalize.go:61-64) and has no per-call override;
//   - DiscoveryMode: the Go sitemap chain always reads robots.txt and then the
//     default sitemap paths (sitemap.go:170-183) and does not branch on the
//     mode, so `robots`, `sitemap_only` and `common_paths` behave alike here
//     (`common_paths` skips the robots probe in NestJS). The `disabled` mode is
//     the one value that changes the outcome completely, so it is honored below
//     before any fetch;
//   - the remaining CrawlSitemapDiscoveryDiagnostics fields (seedMethod,
//     robotsUrl, robotsDiscoveredSitemaps, attemptedSitemaps, fetchedSitemaps,
//     parsedSitemaps) are not tracked, so the diagnostics carry only
//     discoveryMode (the requested mode, as NestJS records it) and
//     candidateCount. seedMethod therefore stays null downstream.
func (s *Service) discoverSitemapSeeds(ctx context.Context, input sitemapSeedInput) (*sitemapSeedResult, error) {
	// `discoveryMode === "disabled"` is a hard off switch in NestJS:
	// CrawlMetadataService.resolveSitemapSeedUrls returns no seed URL at all, so
	// the run discovers no seed candidate and creates no seed node. The Go sitemap
	// chain (internal/crawlmetadata) has no mode parameter, so the switch is
	// honored here — before any fetch — and the diagnostics keep the requested
	// mode with a zero count, exactly like the NestJS early return.
	if input.DiscoveryMode == "disabled" {
		diagnostics := crawlfrontierllm.NewObject()
		diagnostics.SetString("discoveryMode", input.DiscoveryMode)
		diagnostics.SetNumber("candidateCount", 0)
		return &sitemapSeedResult{Candidates: []crawlmetadata.DiscoveryCandidate{}, Diagnostics: diagnostics}, nil
	}
	if s.metadata == nil {
		return &sitemapSeedResult{}, nil
	}
	maxURLs := input.MaxURLs
	freshnessCutoffTs := input.FreshnessCutoffTs
	candidates, err := s.metadata.DiscoverSitemapSeedCandidates(ctx, input.Domain, "", &maxURLs, &freshnessCutoffTs)
	if err != nil {
		return nil, err
	}
	if candidates == nil {
		candidates = []crawlmetadata.DiscoveryCandidate{}
	}
	diagnostics := crawlfrontierllm.NewObject()
	diagnostics.SetString("discoveryMode", input.DiscoveryMode)
	diagnostics.SetNumber("candidateCount", float64(len(candidates)))
	return &sitemapSeedResult{Candidates: candidates, Diagnostics: diagnostics}, nil
}

// shouldQueueLlmJudge ports crawl-frontier.service.ts shouldQueueLlmJudge
// (3144-3157): an article node never defers, an unconfigured judge client or a
// disabled llmAssist never defers, and an empty candidate set never defers.
func (s *Service) shouldQueueLlmJudge(
	node *crawlfrontierllm.NodeRecord,
	profile *crawlfrontierllm.ProfileRecord,
	candidates []crawlfrontierllm.Candidate,
) bool {
	if !s.frontier.HasLlmJudge() {
		return false
	}
	if profile == nil {
		return false
	}
	if crawlfrontierllm.ResolveEffectiveLlmAssistConfig(profile.Config, crawlfrontierllm.LlmPurposeJudge) == nil {
		return false
	}
	if node == nil || node.PageType == "article" {
		return false
	}
	return len(candidates) > 0
}

// applyCandidateDiscoveryMetadata ports crawl-frontier.service.ts
// applyCandidateDiscoveryMetadata (2613-2659). The synthetic-list decision, the
// sourceTier/freshnessBucket merge and the discoveryPath/frontierPath arrays are
// the shared materialize helper, so this delegates instead of copying.
func (s *Service) applyCandidateDiscoveryMetadata(
	node *crawlfrontierllm.NodeRecord,
	config *crawlfrontierllm.Object,
	candidates []crawlfrontierllm.Candidate,
) ([]crawlfrontierllm.Candidate, bool) {
	return s.frontier.ApplyCandidateDiscoveryMetadata(node, config, candidates)
}

// estimateSeedCandidateFreshnessScore ports
// crawl-frontier.service.ts estimateSeedCandidateFreshnessScore (2586-2613): a
// sitemap publish timestamp picks the freshness band from the rules, otherwise
// the URL date heuristic is used.
func (s *Service) estimateSeedCandidateFreshnessScore(
	candidate crawlmetadata.DiscoveryCandidate,
	config *crawlfrontierllm.Object,
) float64 {
	if candidate.PublishedAtTs == nil {
		return frontierEstimateFreshnessScore(candidate.URL, config, s.now())
	}
	ageHours := float64(s.now().UnixMilli()-*candidate.PublishedAtTs) / (1000 * 60 * 60)
	rules := frontierFreshnessRulesFor(config)
	switch {
	case ageHours <= rules.Recent:
		return 1
	case ageHours <= rules.Week:
		return 0.75
	case ageHours <= rules.Month:
		return 0.4
	}
	return 0.1
}

// discoverISOStringOrNull is `typeof ts === "number" ? new Date(ts).toISOString() : null`.
func discoverISOStringOrNull(value *int64) any {
	if value == nil {
		return nil
	}
	return crawlfrontierllm.NestISOString(time.UnixMilli(*value))
}

// discoverMessageInvalidURL is Node's TypeError text for `new URL(<invalid>)`; the crawl
// worker classifies failures by message text, so the literal is preserved.
const discoverMessageInvalidURL = "Invalid URL"

// ---------------------------------------------------------------------------
// crawl-frontier.utils.ts port
//
// These helpers are not exported by crawlfrontierllm yet. Each doc comment names
// the NestJS function and its line range. Once they are hoisted into the shared
// package, every call site below becomes a one-line rename.
// ---------------------------------------------------------------------------

var (
	// ARTICLE_SIGNAL_PATTERN (:30).
	frontierArticleSignalPattern = regexp.MustCompile(`(?i)/(20\d{2}/\d{1,2}/\d{1,2}/|article/|articles/|story/|stories/|content/)`)
	// DATED_ARTICLE_SLUG_PATTERN (:32).
	frontierDatedArticleSlugPattern = regexp.MustCompile(`(?i)(?:^|/)[^/?#]+-\d{4}-\d{1,2}-\d{1,2}/?$`)
	// LIST_SIGNAL_PATTERN (:34).
	frontierListSignalPattern = regexp.MustCompile(`(?i)(?:[?&](?:page|p)=\d+\b|/page/\d+(?:/|$)|/(?:latest|archive|archives|index)(?:/|$))`)
	// CATEGORY_SIGNAL_PATTERN (:36).
	frontierCategorySignalPattern = regexp.MustCompile(`(?i)/(?:section|sections|category|categories|channel|channels|desk|desks|vertical|verticals)(?:/|$)`)
	// NON_ARTICLE_SIGNAL_PATTERN (:38).
	frontierNonArticleSignalPattern = regexp.MustCompile(`(?i)/(?:section|sections|topic|topics|tag|tags|author|authors|profile|profiles|series|search|newsletter|newsletters|gallery|galleries|video|videos|podcast|podcasts)(?:/|$)`)
	// UTILITY_PATH_PATTERN (:40).
	frontierUtilityPathPattern = regexp.MustCompile(`(?i)/(?:about|contact|contacts|donate|support|help|jobs|careers|advertis(?:e|ing)|press|privacy|terms|sitemap|site-map|account|login|log-in|signin|sign-in|register|signup|sign-up|subscribe|subscription|membership|shop|store|apps?|network|community-guidelines|code-of-ethics|ethics|schedule|schedules|today-in-history|photography|photo-gallery|photo-essays|video|videos|podcast|podcasts|newsletter|newsletters|gallery|galleries|rss|xml|sponsored|stay-connected|regulatory|eu-eea-regulatory|accessibility(?:-statement)?|insidetheguardian|profile|profiles|author|authors|contributors?|bios?|editorial|tabs-[a-z0-9-]+)(?:/|$)`)
	// UTILITY_LINK_TEXT_PATTERN (:42).
	frontierUtilityLinkTextPattern = regexp.MustCompile(`(?i)\b(?:about(?: us)?|contact(?: us)?|donate|support|help(?: center)?|jobs|careers|advertis(?:e|ing)|press|privacy|terms|site map|account|log(?:\s|-)?in|sign(?:\s|-)?in|register|sign(?:\s|-)?up|subscribe|subscription|membership|shop|store|download app|our network|community guidelines|code of ethics|schedule|today in history|photo gallery|photo essay|photography|video|podcasts?|newsletters?|rss|sponsored|stay connected|regulatory|accessibility|inside the guardian|editorial profile|author profile|our writers)\b`)
	// estimateFreshnessScore's date segment regex (:1255).
	frontierFreshnessDatePattern = regexp.MustCompile(`/(20\d{2})/(\d{1,2})/(\d{1,2})/`)
)

// COMPOUND_PUBLIC_SUFFIXES (:44): the two-label public suffixes
// toRegistrableDomain keeps three labels for.
var frontierCompoundPublicSuffixes = map[string]struct{}{
	"co.uk": {}, "org.uk": {}, "gov.uk": {}, "ac.uk": {}, "com.au": {},
	"net.au": {}, "org.au": {}, "co.nz": {}, "com.br": {}, "com.mx": {},
	"com.tr": {}, "com.cn": {}, "com.hk": {}, "com.tw": {}, "com.sg": {},
	"co.jp": {}, "co.kr": {}, "co.in": {}, "co.id": {}, "co.il": {},
	"com.ar": {}, "com.sa": {}, "com.ng": {},
}

// LOCALE_ALIAS_LANGUAGE_MAP (:120): the path/host aliases
// resolveForeignLocaleAlias treats as a foreign language.
var frontierLocaleAliasLanguage = map[string]string{
	"zhongwen": "zh", "chinese": "zh",
	"espanol": "es", "espana": "es", "spanish": "es", "mundo": "es",
	"francais": "fr", "french": "fr",
	"deutsch": "de", "german": "de",
	"portuguese": "pt", "portugues": "pt", "brasil": "pt",
	"arabic": "ar", "russian": "ru", "hindi": "hi", "japanese": "ja",
	"korean": "ko", "turkiye": "tr", "turkce": "tr", "indonesia": "id",
	"vietnam": "vi",
}

// frontierPageTypeOptions is inferFrontierPageType's argument object (:983).
type frontierPageTypeOptions struct {
	URL            string
	ParentPageType string
	Config         *crawlfrontierllm.Object
	LinkText       *string
	// PublishedAtTs is `number | null` in NestJS; nil is null/undefined.
	PublishedAtTs *int64
}

// frontierScoreOptions is scoreFrontierCandidate's argument object (:1090).
type frontierScoreOptions struct {
	URL            string
	PageType       string
	ParentPageType string
	ParentURL      string
	Config         *crawlfrontierllm.Object
	RawScore       float64
	LinkText       *string
	FreshnessScore *float64
}

// frontierRejectURLOptions is shouldRejectFrontierUrl's argument object (:1370).
type frontierRejectURLOptions struct {
	URL                   string
	Config                *crawlfrontierllm.Object
	RequireSameDomainHost *string
	LinkText              *string
}

// frontierFreshnessRules is CrawlFreshnessRules with the source defaults applied.
type frontierFreshnessRules struct {
	Recent float64
	Week   float64
	Month  float64
}

// frontierFreshnessRulesFor is `config?.freshnessRules` with the 24/168/720
// hour fallbacks (:1271-1273).
func frontierFreshnessRulesFor(config *crawlfrontierllm.Object) frontierFreshnessRules {
	rules := frontierFreshnessRules{Recent: 24, Week: 24 * 7, Month: 24 * 30}
	if object, ok := config.Object("freshnessRules"); ok {
		if value, ok := object.Number("recentHours"); ok {
			rules.Recent = value
		}
		if value, ok := object.Number("weekHours"); ok {
			rules.Week = value
		}
		if value, ok := object.Number("monthHours"); ok {
			rules.Month = value
		}
	}
	return rules
}

// frontierInferPageType ports inferFrontierPageType (:983-1051). The order of
// the checks is the NestJS order and is observable: a configured article signal
// wins over a configured list pattern.
func frontierInferPageType(options frontierPageTypeOptions) string {
	rawURL := options.URL
	hasPublishedTimestamp := options.PublishedAtTs != nil
	matchesNonArticleSignal := frontierNonArticleSignalPattern.MatchString(rawURL)
	matchesArticleHeuristic := !matchesNonArticleSignal &&
		(frontierArticleSignalPattern.MatchString(rawURL) || frontierDatedArticleSlugPattern.MatchString(rawURL))
	if frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "article"), rawURL, options.LinkText) {
		return "article"
	}
	if frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "list"), rawURL, options.LinkText) {
		return "list"
	}
	if frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "home"), rawURL, options.LinkText) {
		return "home"
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "article"), rawURL) {
		return "article"
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "list"), rawURL) {
		return "list"
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "home"), rawURL) {
		return "home"
	}
	if hasPublishedTimestamp &&
		!matchesNonArticleSignal &&
		!frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "exclude"), rawURL) &&
		!frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "deny"), rawURL, options.LinkText) {
		return "article"
	}
	if matchesArticleHeuristic {
		return "article"
	}
	if frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "category"), rawURL, options.LinkText) {
		return "category"
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "category"), rawURL) {
		return "category"
	}
	if frontierListSignalPattern.MatchString(rawURL) {
		return frontierInferNonArticleHubPageType(options.ParentPageType)
	}
	if frontierCategorySignalPattern.MatchString(rawURL) || matchesNonArticleSignal {
		return frontierInferNonArticleHubPageType(options.ParentPageType)
	}
	switch options.ParentPageType {
	case "home":
		return "category"
	case "category":
		return "list"
	case "list":
		return "list"
	}
	return "article"
}

// frontierInferNonArticleHubPageType ports inferNonArticleHubPageType (:975).
func frontierInferNonArticleHubPageType(parentPageType string) string {
	if parentPageType == "home" {
		return "category"
	}
	if parentPageType == "article" {
		return "article"
	}
	return "list"
}

// frontierScoreCandidate ports scoreFrontierCandidate (:1090-1190). The page
// type and parent-page-type bonuses are additive and the result is
// Number(score.toFixed(4)).
func frontierScoreCandidate(options frontierScoreOptions) float64 {
	score := options.RawScore
	switch options.PageType {
	case "article":
		score += 0.35
	case "list":
		score += 0.2
	case "category":
		score += 0.1
	}
	switch options.ParentPageType {
	case "home":
		switch options.PageType {
		case "category":
			score += 0.6
		case "list":
			score += 0.35
		case "article":
			score -= 0.25
		}
	case "category":
		switch options.PageType {
		case "list":
			score += 0.35
		case "category":
			score -= 0.1
		}
	case "list":
		switch options.PageType {
		case "article":
			score += 0.35
		case "list":
			score -= 0.05
		case "category":
			score -= 0.15
		}
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "exclude"), options.URL) {
		score -= 1
	}
	matchesConfiguredScope := frontierMatchesSignalConfig(
		frontierPageTypeSignal(options.Config, options.PageType), options.URL, options.LinkText,
	) ||
		frontierMatchesAnyPattern(frontierURLPatterns(options.Config, options.PageType), options.URL) ||
		frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "home"), options.URL) ||
		frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "category"), options.URL) ||
		frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "list"), options.URL) ||
		frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "article"), options.URL)
	if matchesConfiguredScope {
		score += 0.8
	}
	parentPathSegments := frontierPathSegments(options.ParentURL)
	childPathSegments := frontierPathSegments(options.URL)
	if len(parentPathSegments) > 0 && len(childPathSegments) > 0 {
		parentScopeAnchor := parentPathSegments[0]
		if discoverContainsString(childPathSegments, parentScopeAnchor) {
			score += 0.6
		} else if matchesConfiguredScope {
			score -= 0.25
		} else {
			score -= 1.5
		}
	}
	text := ""
	if options.LinkText != nil {
		text = strings.ToLower(crawlfrontierllm.JsTrim(*options.LinkText))
	}
	loweredURL := strings.ToLower(options.URL)
	for _, keyword := range crawlfrontierllm.ObjectStrings(options.Config, "keywords") {
		needle := strings.ToLower(keyword)
		if strings.Contains(text, needle) || strings.Contains(loweredURL, needle) {
			score += 0.05
		}
	}
	if frontierMatchesConfiguredKeyword(
		crawlfrontierllm.ObjectStrings(options.Config, "priorityKeywords"), options.URL, options.LinkText,
	) {
		score += 0.1
	}
	if frontierMatchesConfiguredKeyword(
		crawlfrontierllm.ObjectStrings(options.Config, "denyKeywords"), options.URL, options.LinkText,
	) {
		score -= 0.35
	}
	freshnessScore := 0.0
	if options.FreshnessScore != nil {
		freshnessScore = *options.FreshnessScore
	}
	switch {
	case freshnessScore >= 0.99:
		score += 0.35
	case freshnessScore >= 0.74:
		score += 0.2
	case freshnessScore >= 0.39:
		score += 0.05
	}
	return crawlfrontierllm.RoundToFixed(score, 4)
}

// frontierEstimateFreshnessScore ports estimateFreshnessScore (:1253-1284): the
// /YYYY/M/D/ path date decides the band, everything else is 0. `now` is the
// service clock because NestJS calls `new Date()`.
func frontierEstimateFreshnessScore(rawURL string, config *crawlfrontierllm.Object, now time.Time) float64 {
	match := frontierFreshnessDatePattern.FindStringSubmatch(rawURL)
	if match == nil {
		return 0
	}
	year, err := strconv.Atoi(match[1])
	if err != nil {
		return 0
	}
	month, err := strconv.Atoi(match[2])
	if err != nil {
		return 0
	}
	day, err := strconv.Atoi(match[3])
	if err != nil {
		return 0
	}
	// `new Date(Date.UTC(year, month - 1, day))`: the parsed month is 1-based
	// and time.Date normalizes overflow the way Date.UTC does.
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	ageHours := float64(now.UnixMilli()-parsed.UnixMilli()) / (1000 * 60 * 60)
	rules := frontierFreshnessRulesFor(config)
	switch {
	case ageHours <= rules.Recent:
		return 1
	case ageHours <= rules.Week:
		return 0.75
	case ageHours <= rules.Month:
		return 0.4
	}
	return 0.1
}

// frontierIsUtilityURL ports isUtilityFrontierUrl (:1219).
func frontierIsUtilityURL(rawURL string) bool {
	parsed, ok := frontierParseAbsoluteURL(rawURL)
	if !ok {
		return false
	}
	return frontierUtilityPathPattern.MatchString(strings.ToLower(parsed.EscapedPath()))
}

// frontierIsUtilityLinkText ports isUtilityFrontierLinkText (:1228).
func frontierIsUtilityLinkText(value *string) bool {
	if value == nil {
		return false
	}
	text := strings.ToLower(crawlfrontierllm.JsTrim(*value))
	if text == "" {
		return false
	}
	return frontierUtilityLinkTextPattern.MatchString(text)
}

// frontierShouldRejectURL ports shouldRejectFrontierUrl (:1370-1440): the first
// failing rule names the rejection reason, exactly like the NestJS order.
func frontierShouldRejectURL(options frontierRejectURLOptions) *string {
	parsed, ok := frontierParseAbsoluteURL(options.URL)
	if !ok {
		return stringPointer("invalid_url")
	}
	host := strings.ToLower(parsed.Hostname())
	if options.RequireSameDomainHost != nil &&
		!frontierIsAllowedHost(host, options.Config, *options.RequireSameDomainHost) {
		return stringPointer("cross_domain")
	}
	for _, blockedDomain := range crawlfrontierllm.ObjectStrings(options.Config, "blockedDomains") {
		normalized := strings.ToLower(blockedDomain)
		if host == normalized || strings.HasSuffix(host, "."+normalized) {
			return stringPointer("blocked_domain")
		}
	}
	if localeScope, ok := options.Config.Object("localeScope"); ok {
		for _, pattern := range crawlfrontierllm.ObjectStrings(localeScope, "denyHostPatterns") {
			if frontierMatchHostPattern(pattern, host) {
				return stringPointer("foreign_locale")
			}
		}
		if frontierMatchesAnyPattern(crawlfrontierllm.ObjectStrings(localeScope, "denyUrlPatterns"), options.URL) {
			return stringPointer("foreign_locale")
		}
	}
	if frontierForeignLocaleAlias(options.URL, frontierPreferredLanguage(options.Config)) != "" {
		return stringPointer("foreign_locale")
	}
	if frontierIsUtilityURL(options.URL) {
		return stringPointer("utility_url")
	}
	if frontierMatchesConfiguredKeyword(
		crawlfrontierllm.ObjectStrings(options.Config, "denyKeywords"), options.URL, options.LinkText,
	) {
		return stringPointer("deny_keyword")
	}
	if frontierMatchesSignalConfig(frontierPageTypeSignal(options.Config, "deny"), options.URL, options.LinkText) {
		return stringPointer("deny_signal")
	}
	if frontierMatchesAnyPattern(frontierURLPatterns(options.Config, "exclude"), options.URL) {
		return stringPointer("excluded_pattern")
	}
	return nil
}

// frontierPageTypeSignal is `config.pageTypeSignals?.[key]`.
func frontierPageTypeSignal(config *crawlfrontierllm.Object, key string) *crawlfrontierllm.Object {
	signals, ok := config.Object("pageTypeSignals")
	if !ok {
		return nil
	}
	signal, ok := signals.Object(key)
	if !ok {
		return nil
	}
	return signal
}

// frontierURLPatterns is `config.urlPatterns?.[key]`.
func frontierURLPatterns(config *crawlfrontierllm.Object, key string) []string {
	patterns, ok := config.Object("urlPatterns")
	if !ok {
		return nil
	}
	return crawlfrontierllm.ObjectStrings(patterns, key)
}

// frontierMatchesSignalConfig ports matchesSignalConfig (:862): patterns first,
// then keywords, both through matchesSignalPattern.
func frontierMatchesSignalConfig(signal *crawlfrontierllm.Object, rawURL string, linkText *string) bool {
	if signal == nil {
		return false
	}
	for _, pattern := range crawlfrontierllm.ObjectStrings(signal, "patterns") {
		if frontierMatchesSignalPattern(pattern, rawURL, linkText) {
			return true
		}
	}
	for _, keyword := range crawlfrontierllm.ObjectStrings(signal, "keywords") {
		if frontierMatchesSignalPattern(keyword, rawURL, linkText) {
			return true
		}
	}
	return false
}

// frontierMatchesSignalPattern ports matchesSignalPattern (:828): a pattern with
// a wildcard, a scheme or a leading slash is a URL pattern, everything else is a
// lowercase substring of the URL or of the link text.
func frontierMatchesSignalPattern(pattern, rawURL string, linkText *string) bool {
	normalizedPattern := strings.ToLower(crawlfrontierllm.JsTrim(pattern))
	if normalizedPattern == "" {
		return false
	}
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := ""
	if linkText != nil {
		normalizedText = strings.ToLower(crawlfrontierllm.JsTrim(*linkText))
	}
	if strings.Contains(normalizedPattern, "*") ||
		strings.Contains(normalizedPattern, "://") ||
		strings.HasPrefix(normalizedPattern, "/") {
		return frontierMatchURLPattern(pattern, rawURL)
	}
	return strings.Contains(normalizedURL, normalizedPattern) || strings.Contains(normalizedText, normalizedPattern)
}

// frontierMatchesConfiguredKeyword ports matchesConfiguredKeyword (:879).
func frontierMatchesConfiguredKeyword(keywords []string, rawURL string, linkText *string) bool {
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := ""
	if linkText != nil {
		normalizedText = strings.ToLower(crawlfrontierllm.JsTrim(*linkText))
	}
	for _, keyword := range keywords {
		normalizedKeyword := strings.ToLower(crawlfrontierllm.JsTrim(keyword))
		if normalizedKeyword == "" {
			continue
		}
		if strings.Contains(normalizedURL, normalizedKeyword) || strings.Contains(normalizedText, normalizedKeyword) {
			return true
		}
	}
	return false
}

// frontierMatchesAnyPattern ports matchesAnyPattern (:820).
func frontierMatchesAnyPattern(patterns []string, rawURL string) bool {
	for _, pattern := range patterns {
		if frontierMatchURLPattern(pattern, rawURL) {
			return true
		}
	}
	return false
}

// frontierMatchURLPattern ports matchUrlPattern (:799): a bare path is a
// pathname substring match, everything else is an anchored wildcard.
func frontierMatchURLPattern(pattern, rawURL string) bool {
	normalizedPattern := crawlfrontierllm.JsTrim(pattern)
	if normalizedPattern == "" {
		return false
	}
	if strings.HasPrefix(normalizedPattern, "/") && !strings.Contains(normalizedPattern, "*") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return false
		}
		return strings.Contains(parsed.EscapedPath(), normalizedPattern)
	}
	compiled := frontierWildcardRegex(normalizedPattern)
	if compiled == nil {
		return false
	}
	return compiled.MatchString(rawURL)
}

// frontierMatchHostPattern ports matchHostPattern (:780).
func frontierMatchHostPattern(pattern, host string) bool {
	normalizedPattern := strings.ToLower(crawlfrontierllm.JsTrim(pattern))
	normalizedHost := strings.ToLower(crawlfrontierllm.JsTrim(host))
	if normalizedPattern == "" || normalizedHost == "" {
		return false
	}
	if normalizedPattern == normalizedHost {
		return true
	}
	if strings.HasPrefix(normalizedPattern, "*.") {
		return strings.HasSuffix(normalizedHost, normalizedPattern[1:])
	}
	if strings.Contains(normalizedPattern, "*") {
		compiled := frontierWildcardRegex(normalizedPattern)
		return compiled != nil && compiled.MatchString(normalizedHost)
	}
	return normalizedHost == normalizedPattern
}

// frontierWildcardRegex is wildcardToRegex (:172): escapeRegex, then `*` -> `.*`,
// anchored and case-insensitive.
func frontierWildcardRegex(pattern string) *regexp.Regexp {
	normalized := crawlfrontierllm.JsTrim(pattern)
	body := strings.ReplaceAll(frontierEscapePattern(normalized), "*", ".*")
	compiled, err := regexp.Compile("(?i)^" + body + "$")
	if err != nil {
		return nil
	}
	return compiled
}

// frontierEscapePattern is escapeRegex (:167): every member of
// `[|\\{}()[\]^$+?.]` is backslash-escaped, `*` is left for the wildcard step.
func frontierEscapePattern(value string) string {
	const metacharacters = `|\{}()[]^$+?.`
	var builder strings.Builder
	for _, char := range value {
		if strings.ContainsRune(metacharacters, char) {
			builder.WriteByte('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// frontierIsAllowedHost ports isAllowedFrontierHost (:1330): the allowed hosts,
// the allowed domains (registrable domain aware) plus the current node host.
func frontierIsAllowedHost(host string, config *crawlfrontierllm.Object, requireSameDomainHost string) bool {
	normalizedHost := frontierNormalizeHostname(host)
	strictHostAllowlist := frontierHostScope(config) == "strict_hosts"
	allowedHosts := map[string]struct{}{}
	for _, entry := range crawlfrontierllm.ObjectStrings(config, "allowedHosts") {
		allowedHosts[frontierNormalizeHostname(entry)] = struct{}{}
	}
	allowedDomains := map[string]struct{}{}
	if !strictHostAllowlist {
		for _, entry := range crawlfrontierllm.ObjectStrings(config, "allowedDomains") {
			allowedDomains[frontierNormalizeDomain(entry)] = struct{}{}
		}
	}
	if baseHost := frontierNormalizeHostname(requireSameDomainHost); baseHost != "" {
		allowedHosts[baseHost] = struct{}{}
		if !strictHostAllowlist {
			if registrable := frontierRegistrableDomain(baseHost); registrable != "" {
				allowedDomains[registrable] = struct{}{}
			}
		}
	}
	for pattern := range allowedHosts {
		if frontierMatchHostPattern(pattern, normalizedHost) {
			return true
		}
	}
	for domain := range allowedDomains {
		if frontierMatchesAllowedDomain(normalizedHost, domain) {
			return true
		}
	}
	return false
}

// frontierMatchesAllowedDomain ports matchesAllowedDomain (:1313).
func frontierMatchesAllowedDomain(host, domain string) bool {
	normalizedHost := frontierNormalizeHostname(host)
	normalizedDomain := frontierNormalizeDomain(domain)
	if normalizedDomain == "" {
		return false
	}
	return normalizedHost == normalizedDomain ||
		strings.HasSuffix(normalizedHost, "."+normalizedDomain) ||
		frontierRegistrableDomain(normalizedHost) == normalizedDomain
}

// frontierRegistrableDomain ports toRegistrableDomain (:1302). NestJS returns
// null for a missing hostname; the empty string is the Go form.
func frontierRegistrableDomain(hostname string) string {
	if hostname == "" {
		return ""
	}
	normalized := frontierNormalizeDomain(hostname)
	if normalized == "" || !strings.Contains(normalized, ".") {
		return normalized
	}
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(normalized, ".") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) <= 2 {
		return normalized
	}
	tail := parts[len(parts)-2] + "." + parts[len(parts)-1]
	if _, ok := frontierCompoundPublicSuffixes[tail]; ok && len(parts) >= 3 {
		return parts[len(parts)-3] + "." + tail
	}
	return tail
}

// frontierHostScope ports resolveFrontierHostScope (:886).
func frontierHostScope(config *crawlfrontierllm.Object) string {
	if scope, ok := config.String("hostScope"); ok {
		return scope
	}
	if len(crawlfrontierllm.ObjectStrings(config, "allowedHosts")) > 0 &&
		len(crawlfrontierllm.ObjectStrings(config, "allowedDomains")) == 0 {
		return "strict_hosts"
	}
	return "registrable_domain"
}

// frontierNormalizeHostname ports normalizeHostname (:139).
func frontierNormalizeHostname(value string) string {
	return strings.Trim(strings.ToLower(crawlfrontierllm.JsTrim(value)), ".")
}

// frontierNormalizeDomain ports normalizeDomain (:143).
func frontierNormalizeDomain(value string) string {
	return strings.TrimPrefix(frontierNormalizeHostname(value), "www.")
}

// frontierPreferredLanguage ports resolvePreferredLanguageCode (:920): the
// localeScope locale first, then the acceptLanguages list.
func frontierPreferredLanguage(config *crawlfrontierllm.Object) string {
	localeScope, ok := config.Object("localeScope")
	if !ok {
		return ""
	}
	if locale := discoverStringLeaf(localeScope, "locale"); locale != nil {
		if language := frontierNormalizeLanguageCode(locale); language != "" {
			return language
		}
	}
	for _, entry := range crawlfrontierllm.ObjectStrings(localeScope, "acceptLanguages") {
		if language := frontierNormalizeLanguageCode(&entry); language != "" {
			return language
		}
	}
	return ""
}

// frontierNormalizeLanguageCode ports normalizeLanguageCode (:899).
func frontierNormalizeLanguageCode(value *string) string {
	if value == nil {
		return ""
	}
	normalized := strings.ToLower(crawlfrontierllm.JsTrim(*value))
	if normalized == "" {
		return ""
	}
	base := normalized
	if index := strings.IndexAny(base, "-_"); index >= 0 {
		base = base[:index]
	}
	if len(base) < 2 || len(base) > 3 {
		return ""
	}
	for _, char := range base {
		if char < 'a' || char > 'z' {
			return ""
		}
	}
	return base
}

// frontierForeignLocaleAlias ports resolveForeignLocaleAlias (:938): a path
// segment or the first host label that names another language.
func frontierForeignLocaleAlias(rawURL, preferredLanguage string) string {
	if preferredLanguage == "" {
		return ""
	}
	parsed, ok := frontierParseAbsoluteURL(rawURL)
	if !ok {
		return ""
	}
	candidates := make([]string, 0, 2)
	for _, segment := range frontierSplitPathSegments(parsed.EscapedPath()) {
		if segment != "" {
			candidates = append(candidates, segment)
			break
		}
	}
	hostLabels := make([]string, 0, 4)
	for _, label := range strings.Split(strings.ToLower(parsed.Hostname()), ".") {
		if trimmed := crawlfrontierllm.JsTrim(label); trimmed != "" {
			hostLabels = append(hostLabels, trimmed)
		}
	}
	if len(hostLabels) > 0 {
		candidates = append(candidates, hostLabels[0])
	}
	for _, alias := range candidates {
		if language, ok := frontierLocaleAliasLanguage[alias]; ok && language != preferredLanguage {
			return language
		}
	}
	return ""
}

// frontierPathSegments ports extractPathSegments (:891).
func frontierPathSegments(rawURL string) []string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	return frontierSplitPathSegments(parsed.EscapedPath())
}

// frontierSplitPathSegments is `pathname.split("/").map(trim+lower).filter(non-empty)`.
func frontierSplitPathSegments(pathname string) []string {
	segments := make([]string, 0, 4)
	for _, segment := range strings.Split(pathname, "/") {
		normalized := strings.ToLower(crawlfrontierllm.JsTrim(segment))
		if normalized == "" {
			continue
		}
		segments = append(segments, normalized)
	}
	return segments
}

// frontierResolveLink is `new URL(href, baseUrl).toString()`: resolve the href
// against the result URL and apply the WHATWG normalizations that change the
// string a reader compares against node.url (lowercase scheme/host, no default
// port, `/` for an empty path). An href WHATWG rejects returns false, which the
// caller records as `invalid_url`.
func frontierResolveLink(href, baseURL string) (string, bool) {
	base, ok := frontierParseAbsoluteURL(baseURL)
	if !ok {
		return "", false
	}
	reference, err := url.Parse(href)
	if err != nil {
		return "", false
	}
	resolved := base.ResolveReference(reference)
	scheme := strings.ToLower(resolved.Scheme)
	switch scheme {
	case "http", "https", "ws", "wss", "ftp":
		if resolved.Host == "" {
			return "", false
		}
		resolved.Scheme = scheme
		normalizedHost := strings.ToLower(resolved.Host)
		if port := resolved.Port(); port != "" && frontierIsDefaultPort(scheme, port) {
			normalizedHost = strings.ToLower(resolved.Hostname())
			if strings.Contains(normalizedHost, ":") {
				normalizedHost = "[" + normalizedHost + "]"
			}
		}
		resolved.Host = normalizedHost
		if resolved.Path == "" {
			resolved.Path = "/"
		}
	default:
		resolved.Scheme = scheme
	}
	return resolved.String(), true
}

// frontierIsDefaultPort reports whether port is the scheme's default, which
// WHATWG drops from the serialized URL.
func frontierIsDefaultPort(scheme, port string) bool {
	switch scheme {
	case "http", "ws":
		return port == "80"
	case "https", "wss":
		return port == "443"
	case "ftp":
		return port == "21"
	}
	return false
}

// frontierParseAbsoluteURL is `new URL(value)` accepting only a value with a
// scheme, and a host for the special schemes. Go's url.Parse accepts relative
// references, which WHATWG rejects.
func frontierParseAbsoluteURL(value string) (*url.URL, bool) {
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme == "" {
		return nil, false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "ws", "wss", "ftp":
		if parsed.Host == "" {
			return nil, false
		}
	}
	return parsed, true
}

// frontierURLOrigin is `new URL(value).origin`.
func frontierURLOrigin(value string) (string, bool) {
	parsed, ok := frontierParseAbsoluteURL(value)
	if !ok {
		return "", false
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), true
}

// frontierURLHostname is `new URL(value).hostname`; an unparsable value has no
// hostname, which is the empty string here.
func frontierURLHostname(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

// discoverContainsString is Array.prototype.includes for the path segments.
func discoverContainsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
