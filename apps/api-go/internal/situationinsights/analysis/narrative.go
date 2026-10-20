package analysis

import (
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// NarrativeLearningOverride mirrors NarrativeLearningOverride.
type NarrativeLearningOverride struct {
	BoostedTokens         []string
	BlockedTokens         []string
	SuppressedItemMetaIDs []string
	FalsePositiveCount    int
	FalseNegativeCount    int
}

// NarrativeOptions is the option bag of analyzeNarratives.
type NarrativeOptions struct {
	Learning map[string]NarrativeLearningOverride
}

var (
	narrativeStopwords = map[string]bool{
		"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
		"be": true, "but": true, "by": true, "for": true, "from": true,
		"has": true, "have": true, "in": true, "into": true, "is": true,
		"it": true, "its": true, "of": true, "on": true, "or": true,
		"that": true, "the": true, "their": true, "them": true, "this": true,
		"to": true, "was": true, "were": true, "with": true,
	}
	asciiTokenPattern   = regexp.MustCompile(`[a-z0-9]{3,24}`)
	cjkTokenPattern     = regexp.MustCompile(`[\x{4e00}-\x{9fff}]{2,8}`)
	urlCitationPattern  = regexp.MustCompile(`(?i)https?://[^\s)]+`)
	trailingURLCitation = regexp.MustCompile(`[),.]+$`)
)

var domainAliases = map[string]string{
	"reuters.com":        "Reuters",
	"apnews.com":         "AP",
	"bbc.co.uk":          "BBC",
	"bbc.com":            "BBC",
	"cnn.com":            "CNN",
	"nytimes.com":        "NYTimes",
	"wsj.com":            "WSJ",
	"washingtonpost.com": "WaPo",
	"theguardian.com":    "Guardian",
	"foxnews.com":        "Fox",
}

var citationMentions = []struct {
	needle string
	label  string
}{
	{"reuters", "Reuters"},
	{"ap news", "AP"},
	{"associated press", "AP"},
	{"bbc", "BBC"},
	{"cnn", "CNN"},
	{"nytimes", "NYTimes"},
	{"wsj", "WSJ"},
	{"wapo", "WaPo"},
	{"guardian", "Guardian"},
	{"fox news", "Fox"},
}

// AnalyzeNarratives mirrors analyzeNarratives.
func AnalyzeNarratives(allNews []NewsItem, options NarrativeOptions) *NarrativeResults {
	if len(allNews) == 0 {
		return nil
	}
	results := &NarrativeResults{
		EmergingFringe:     []EmergingFringe{},
		FringeToMainstream: []FringeToMainstream{},
		NarrativeWatch:     []NarrativeData{},
		DisinfoSignals:     []NarrativeData{},
	}

	for _, narrative := range narrativePatterns {
		learning, ok := options.Learning[narrative.id]
		if !ok {
			learning = NarrativeLearningOverride{}
		}
		boostedTokens := learning.BoostedTokens
		if boostedTokens == nil {
			boostedTokens = []string{}
		}
		blockedTokens := learning.BlockedTokens
		if blockedTokens == nil {
			blockedTokens = []string{}
		}
		suppressed := map[string]bool{}
		for _, item := range learning.SuppressedItemMetaIDs {
			suppressed[item] = true
		}
		feedback := FeedbackStats{
			FalsePositive: learning.FalsePositiveCount,
			FalseNegative: learning.FalseNegativeCount,
		}

		keywords := make([]string, 0, len(narrative.keywords)+len(boostedTokens))
		for _, keyword := range append(append([]string{}, narrative.keywords...), boostedTokens...) {
			lowered := strings.ToLower(keyword)
			if lowered != "" {
				keywords = append(keywords, lowered)
			}
		}
		matches := make([]NewsItem, 0)
		fringeMatches := make([]NewsItem, 0)
		alternativeMatches := make([]NewsItem, 0)
		mainstreamMatches := make([]NewsItem, 0)

		for _, item := range allNews {
			source := strings.ToLower(item.Source)
			if item.ItemMeta != "" && suppressed[item.ItemMeta] {
				continue
			}
			haystack := normalizeForMatchNarrative(item)
			if len(blockedTokens) > 0 {
				blocked := false
				for _, token := range blockedTokens {
					if token != "" && strings.Contains(haystack, strings.ToLower(token)) {
						blocked = true
						break
					}
				}
				if blocked {
					continue
				}
			}
			hasMatch := false
			for _, keyword := range keywords {
				if strings.Contains(haystack, keyword) {
					hasMatch = true
					break
				}
			}
			if !hasMatch {
				continue
			}
			matches = append(matches, item)
			switch classifySource(source) {
			case "fringe":
				fringeMatches = append(fringeMatches, item)
			case "alternative":
				alternativeMatches = append(alternativeMatches, item)
			case "mainstream":
				mainstreamMatches = append(mainstreamMatches, item)
			}
		}

		if len(matches) == 0 {
			continue
		}

		sortedMatches := append([]NewsItem(nil), matches...)
		sort.SliceStable(sortedMatches, func(i, j int) bool {
			return sortedMatches[i].Timestamp > sortedMatches[j].Timestamp
		})

		keywordCopy := append([]string(nil), narrative.keywords...)
		narrativeData := NarrativeData{
			ID:               narrative.id,
			Name:             formatNarrativeName(narrative.id),
			Category:         narrative.category,
			Severity:         narrative.severity,
			Count:            len(sortedMatches),
			FringeCount:      len(fringeMatches),
			AlternativeCount: len(alternativeMatches),
			MainstreamCount:  len(mainstreamMatches),
			Sources:          uniqueStrings(sortedMatches, 5),
			Headlines:        firstNewsItems(sortedMatches, 3),
			Keywords:         keywordCopy,
			Feedback:         &feedback,
			Learning: &LearningSnapshot{
				BoostedTokens:   firstStrings(boostedTokens, 8),
				BlockedTokens:   firstStrings(blockedTokens, 8),
				SuppressedCount: len(suppressed),
			},
		}

		radar := buildCrossSourceRadar(sortedMatches)
		path := buildFringeMainstreamPath(sortedMatches)
		citation := buildCitationChain(sortedMatches)
		credibility := buildCredibility(sortedMatches, radar, citation, feedback)
		narrativeData.Model = &NarrativePropagationModel{
			CrossSourceRadar:       radar,
			FringeToMainstreamPath: path,
			Credibility:            credibility,
			CitationChain:          citation,
		}

		if len(mainstreamMatches) > 0 && len(fringeMatches) > 0 {
			results.FringeToMainstream = append(results.FringeToMainstream, FringeToMainstream{
				NarrativeData:  narrativeData,
				Status:         "crossing",
				CrossoverLevel: float64(len(mainstreamMatches)) / math.Max(1, float64(len(sortedMatches))),
			})
		} else if narrative.severity == "disinfo" {
			results.DisinfoSignals = append(results.DisinfoSignals, narrativeData)
		} else if len(fringeMatches) > 0 || len(alternativeMatches) > 0 {
			status := "emerging"
			if len(sortedMatches) >= 5 {
				status = "viral"
			} else if len(sortedMatches) >= 3 {
				status = "spreading"
			}
			results.EmergingFringe = append(results.EmergingFringe, EmergingFringe{
				NarrativeData: narrativeData,
				Status:        status,
			})
		} else {
			results.NarrativeWatch = append(results.NarrativeWatch, narrativeData)
		}
	}

	sort.SliceStable(results.EmergingFringe, func(i, j int) bool {
		return results.EmergingFringe[i].Count > results.EmergingFringe[j].Count
	})
	sort.SliceStable(results.FringeToMainstream, func(i, j int) bool {
		return results.FringeToMainstream[i].CrossoverLevel > results.FringeToMainstream[j].CrossoverLevel
	})
	sort.SliceStable(results.NarrativeWatch, func(i, j int) bool {
		return results.NarrativeWatch[i].Count > results.NarrativeWatch[j].Count
	})
	sort.SliceStable(results.DisinfoSignals, func(i, j int) bool {
		return results.DisinfoSignals[i].Count > results.DisinfoSignals[j].Count
	})
	return results
}

// GetNarrativeSummary mirrors getNarrativeSummary.
func GetNarrativeSummary(results *NarrativeResults) NarrativeSummary {
	if results == nil {
		return NarrativeSummary{Total: 0, Status: "NO DATA"}
	}
	total := len(results.EmergingFringe) + len(results.FringeToMainstream) +
		len(results.NarrativeWatch) + len(results.DisinfoSignals)
	status := "MONITORING"
	if total > 0 {
		status = itoa(total) + " ACTIVE"
	}
	return NarrativeSummary{Total: total, Status: status}
}

func classifySource(source string) string {
	lower := strings.ToLower(source)
	for _, candidate := range sourceTypesList.fringe {
		if strings.Contains(lower, candidate) {
			return "fringe"
		}
	}
	for _, candidate := range sourceTypesList.alternative {
		if strings.Contains(lower, candidate) {
			return "alternative"
		}
	}
	for _, candidate := range sourceTypesList.mainstream {
		if strings.Contains(lower, candidate) {
			return "mainstream"
		}
	}
	return ""
}

func normalizeForMatchNarrative(item NewsItem) string {
	parts := make([]string, 0, 3)
	if item.Title != "" {
		parts = append(parts, item.Title)
	}
	if item.Summary != "" {
		parts = append(parts, item.Summary)
	}
	if len(item.KeyPoints) > 0 {
		parts = append(parts, strings.Join(item.KeyPoints, " "))
	}
	return strings.ToLower(strings.Join(parts, " "))
}

func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func tokenizeNarrative(text string) map[string]bool {
	out := map[string]bool{}
	for _, token := range asciiTokenPattern.FindAllString(text, -1) {
		if narrativeStopwords[token] {
			continue
		}
		out[token] = true
		if len(out) >= 80 {
			break
		}
	}
	for _, token := range cjkTokenPattern.FindAllString(text, -1) {
		out[token] = true
		if len(out) >= 120 {
			break
		}
	}
	return out
}

func jaccardNarrative(left, right map[string]bool) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for token := range left {
		if right[token] {
			intersection++
		}
	}
	union := len(left) + len(right) - intersection
	if union <= 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

type radarCluster struct {
	id          string
	repTokens   map[string]bool
	items       []NewsItem
	sources     map[string]bool
	sourceOrder []string
}

func buildCrossSourceRadar(matches []NewsItem) CrossSourceRadar {
	maxItems := 80
	items := append([]NewsItem(nil), matches...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })
	if len(items) > maxItems {
		items = items[:maxItems]
	}

	clusters := make([]*radarCluster, 0)
	sourceOrder := make([]string, 0)
	sourceSet := map[string]bool{}
	for _, item := range items {
		text := normalizeForMatchNarrative(item)
		tokens := tokenizeNarrative(text)
		if !sourceSet[item.Source] {
			sourceSet[item.Source] = true
			sourceOrder = append(sourceOrder, item.Source)
		}
		bestIndex := -1
		bestScore := 0.0
		for index, cluster := range clusters {
			score := jaccardNarrative(tokens, cluster.repTokens)
			if score > bestScore {
				bestScore = score
				bestIndex = index
			}
		}
		if bestIndex != -1 && bestScore >= 0.35 {
			cluster := clusters[bestIndex]
			cluster.items = append(cluster.items, item)
			if !cluster.sources[item.Source] {
				cluster.sources[item.Source] = true
				cluster.sourceOrder = append(cluster.sourceOrder, item.Source)
			}
			continue
		}
		clusters = append(clusters, &radarCluster{
			id:          "c" + itoa(len(clusters)+1),
			repTokens:   tokens,
			items:       []NewsItem{item},
			sources:     map[string]bool{item.Source: true},
			sourceOrder: []string{item.Source},
		})
	}

	if len(clusters) == 0 {
		return CrossSourceRadar{Clusters: []CrossSourceRadarCluster{}, OutlierSources: []string{}}
	}
	totalItems := 0
	for _, cluster := range clusters {
		totalItems += len(cluster.items)
	}
	totalSources := len(sourceSet)

	divergence := 0.0
	if len(clusters) > 1 && totalItems > 0 {
		entropy := 0.0
		for _, cluster := range clusters {
			p := float64(len(cluster.items)) / float64(totalItems)
			if p > 0 {
				entropy -= p * math.Log(p)
			}
		}
		divergence = clamp01(entropy / math.Log(float64(len(clusters))))
	}

	mainClusters := append([]*radarCluster(nil), clusters...)
	sort.SliceStable(mainClusters, func(i, j int) bool {
		if len(mainClusters[i].sources) != len(mainClusters[j].sources) {
			return len(mainClusters[i].sources) > len(mainClusters[j].sources)
		}
		return len(mainClusters[i].items) > len(mainClusters[j].items)
	})
	main := mainClusters[0]
	mainCoverage := 0.0
	if totalSources > 0 {
		mainCoverage = float64(len(main.sources)) / float64(totalSources)
	}
	consistency := clamp01(mainCoverage * (1 - divergence))

	outliers := []string{}
	if totalSources > 0 {
		for _, source := range sourceOrder {
			if !main.sources[source] {
				outliers = append(outliers, source)
				if len(outliers) >= 6 {
					break
				}
			}
		}
	}

	sortedClusters := append([]*radarCluster(nil), clusters...)
	sort.SliceStable(sortedClusters, func(i, j int) bool {
		return len(sortedClusters[i].items) > len(sortedClusters[j].items)
	})
	summarized := make([]CrossSourceRadarCluster, 0, 4)
	for _, cluster := range sortedClusters {
		if len(summarized) >= 4 {
			break
		}
		summarized = append(summarized, CrossSourceRadarCluster{
			ID:        cluster.id,
			ItemCount: len(cluster.items),
			Sources:   firstStrings(cluster.sourceOrder, 8),
			Samples:   firstNewsItems(cluster.items, 2),
		})
	}

	return CrossSourceRadar{
		Consistency:    consistency,
		Divergence:     divergence,
		ClusterCount:   len(clusters),
		Clusters:       summarized,
		OutlierSources: outliers,
	}
}

func buildFringeMainstreamPath(matches []NewsItem) FringeMainstreamPath {
	buckets := map[string][]NewsItem{
		"fringe": {}, "alternative": {}, "mainstream": {}, "unknown": {},
	}
	for _, item := range matches {
		tier := classifySource(item.Source)
		if tier == "" {
			tier = "unknown"
		}
		buckets[tier] = append(buckets[tier], item)
	}
	steps := make([]FringeMainstreamPathStep, 0, 4)
	for _, tier := range []string{"fringe", "alternative", "mainstream", "unknown"} {
		items := buckets[tier]
		if len(items) == 0 {
			continue
		}
		first := items[0].Timestamp
		last := items[0].Timestamp
		for _, item := range items[1:] {
			if item.Timestamp < first {
				first = item.Timestamp
			}
			if item.Timestamp > last {
				last = item.Timestamp
			}
		}
		steps = append(steps, FringeMainstreamPathStep{
			Tier:        tier,
			FirstSeenAt: first,
			LastSeenAt:  last,
			Count:       len(items),
			Sources:     uniqueStrings(items, 8),
		})
	}
	var lag *int64
	var fringe, mainstream *FringeMainstreamPathStep
	for index := range steps {
		switch steps[index].Tier {
		case "fringe":
			fringe = &steps[index]
		case "mainstream":
			mainstream = &steps[index]
		}
	}
	if fringe != nil && mainstream != nil && fringe.FirstSeenAt > 0 && mainstream.FirstSeenAt > fringe.FirstSeenAt {
		value := mainstream.FirstSeenAt - fringe.FirstSeenAt
		lag = &value
	}
	return FringeMainstreamPath{Steps: steps, LagToMainstreamMs: lag}
}

func tryDomain(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func normalizeSourceLabel(source, link string) string {
	domain := ""
	if link != "" {
		domain = tryDomain(link)
	}
	if domain != "" {
		for key, label := range domainAliases {
			if domain == key || strings.HasSuffix(domain, "."+key) {
				return label
			}
		}
		return domain
	}
	if trimmed := strings.TrimSpace(source); trimmed != "" {
		return trimmed
	}
	return "Unknown"
}

func extractCitationTargets(text string) []string {
	targets := make([]string, 0)
	seen := map[string]bool{}
	add := func(value string) {
		if value != "" && !seen[value] {
			seen[value] = true
			targets = append(targets, value)
		}
	}
	for _, rawURL := range urlCitationPattern.FindAllString(text, -1) {
		trimmed := trailingURLCitation.ReplaceAllString(rawURL, "")
		add(tryDomain(trimmed))
	}
	lower := strings.ToLower(text)
	for _, mention := range citationMentions {
		if strings.Contains(lower, mention.needle) {
			add(mention.label)
		}
	}
	return targets
}

func normalizeCitationTarget(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if !strings.Contains(trimmed, ".") {
		return trimmed
	}
	for key, label := range domainAliases {
		if trimmed == key || strings.HasSuffix(trimmed, "."+key) || strings.HasSuffix(trimmed, key) {
			return label
		}
	}
	return trimmed
}

func buildCitationChain(matches []NewsItem) CitationChain {
	const maxItems = 60
	items := append([]NewsItem(nil), matches...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	nodes := make([]string, 0)
	nodeSeen := map[string]bool{}
	addNode := func(value string) {
		if value != "" && !nodeSeen[value] {
			nodeSeen[value] = true
			nodes = append(nodes, value)
		}
	}
	type edge struct {
		from string
		to   string
	}
	edgeOrder := make([]edge, 0)
	edgeWeights := map[string]int{}
	citedByCount := 0
	for _, item := range items {
		from := normalizeSourceLabel(item.Source, item.Link)
		addNode(from)
		text := normalizeForMatchNarrative(item)
		uniqueTargets := make([]string, 0)
		targetSeen := map[string]bool{}
		for _, rawTarget := range extractCitationTargets(text) {
			target := normalizeCitationTarget(rawTarget)
			if target == "" || target == from || targetSeen[target] {
				continue
			}
			targetSeen[target] = true
			uniqueTargets = append(uniqueTargets, target)
		}
		if len(uniqueTargets) > 0 {
			citedByCount++
		}
		for _, target := range uniqueTargets {
			addNode(target)
			key := from + "=>" + target
			if edgeWeights[key] == 0 {
				edgeOrder = append(edgeOrder, edge{from: from, to: target})
			}
			edgeWeights[key]++
		}
	}
	links := make([]CitationLink, 0, len(edgeOrder))
	for _, item := range edgeOrder {
		links = append(links, CitationLink{
			From:   item.from,
			To:     item.to,
			Weight: edgeWeights[item.from+"=>"+item.to],
		})
	}
	sort.SliceStable(links, func(i, j int) bool { return links[i].Weight > links[j].Weight })
	if len(links) > 25 {
		links = links[:25]
	}

	type citationWeight struct {
		source string
		weight int
	}
	inWeights := map[string]int{}
	inOrder := make([]string, 0)
	for _, link := range links {
		if inWeights[link.To] == 0 {
			inOrder = append(inOrder, link.To)
		}
		inWeights[link.To] += link.Weight
	}
	top := make([]citationWeight, 0, len(inOrder))
	for _, source := range inOrder {
		top = append(top, citationWeight{source: source, weight: inWeights[source]})
	}
	sort.SliceStable(top, func(i, j int) bool { return top[i].weight > top[j].weight })
	if len(top) > 8 {
		top = top[:8]
	}
	chain := CitationChain{
		Nodes:        firstStrings(nodes, 30),
		Links:        links,
		CitedByCount: citedByCount,
	}
	chain.TopCited = make([]struct {
		Source string `json:"source"`
		Weight int    `json:"weight"`
	}, 0, len(top))
	for _, entry := range top {
		chain.TopCited = append(chain.TopCited, struct {
			Source string `json:"source"`
			Weight int    `json:"weight"`
		}{Source: entry.source, Weight: entry.weight})
	}
	return chain
}

func buildCredibility(matches []NewsItem, radar CrossSourceRadar, citation CitationChain, feedback FeedbackStats) CredibilityAssessment {
	tiers := map[string]map[string]bool{
		"fringe": {}, "alternative": {}, "mainstream": {}, "unknown": {},
	}
	for _, item := range matches {
		tier := classifySource(item.Source)
		if tier == "" {
			tier = "unknown"
		}
		tiers[tier][normalizeSourceLabel(item.Source, item.Link)] = true
	}
	allSources := map[string]bool{}
	for _, set := range tiers {
		for source := range set {
			allSources[source] = true
		}
	}
	totalSources := len(allSources)
	sourceReliability := 0.0
	if totalSources > 0 {
		sourceReliability = (float64(len(tiers["mainstream"]))*0.85 +
			float64(len(tiers["alternative"]))*0.6 +
			float64(len(tiers["fringe"]))*0.3 +
			float64(len(tiers["unknown"]))*0.5) / float64(totalSources)
	}
	corroboration := clamp01(float64(totalSources) / 6)
	citationSupport := clamp01(float64(citation.CitedByCount) / math.Max(1, float64(len(matches))))
	divergence := clamp01(radar.Divergence)
	feedbackPenalty := clamp01(float64(feedback.FalsePositive) / float64(feedback.FalsePositive+3))

	score01 := 0.5*clamp01(sourceReliability) + 0.25*corroboration +
		0.15*citationSupport + 0.1*(1-divergence)
	score01 = clamp01(score01 * (1 - 0.4*feedbackPenalty))
	score := int(math.Round(score01 * 100))
	level := "low"
	if score >= 70 {
		level = "high"
	} else if score >= 45 {
		level = "medium"
	}
	reasons := make([]string, 0, 4)
	if len(tiers["mainstream"]) > 0 {
		reasons = append(reasons, "Mainstream coverage present")
	} else if len(tiers["fringe"]) > 0 {
		reasons = append(reasons, "Primarily fringe sources")
	}
	if divergence >= 0.6 {
		reasons = append(reasons, "High cross-source divergence")
	}
	if citationSupport < 0.2 {
		reasons = append(reasons, "Weak citation/attribution signals")
	}
	if feedback.FalsePositive >= 2 {
		reasons = append(reasons, "Recent false-positive feedback")
	}
	if len(reasons) > 4 {
		reasons = reasons[:4]
	}
	return CredibilityAssessment{
		Score:   score,
		Level:   level,
		Reasons: reasons,
		Components: CredibilityComponents{
			SourceReliability: clamp01(sourceReliability),
			Corroboration:     corroboration,
			CitationSupport:   citationSupport,
			Divergence:        divergence,
			FeedbackPenalty:   feedbackPenalty,
		},
	}
}

func formatNarrativeName(id string) string {
	return formatIDTitle(id)
}

func uniqueStrings(items []NewsItem, limit int) []string {
	out := make([]string, 0, limit)
	seen := map[string]bool{}
	for _, item := range items {
		if seen[item.Source] {
			continue
		}
		seen[item.Source] = true
		out = append(out, item.Source)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func firstNewsItems(items []NewsItem, limit int) []NewsItem {
	if len(items) > limit {
		items = items[:limit]
	}
	out := make([]NewsItem, len(items))
	copy(out, items)
	return out
}

func firstStrings(items []string, limit int) []string {
	if len(items) > limit {
		items = items[:limit]
	}
	out := make([]string, len(items))
	copy(out, items)
	return out
}
