package analysis

import (
	"math"
	"sort"
	"strings"
)

// CorrelationLearningOverride mirrors CorrelationLearningOverride.
type CorrelationLearningOverride struct {
	BoostedTokens         []string
	BlockedTokens         []string
	SuppressedItemMetaIDs []string
	FalsePositiveCount    int
	FalseNegativeCount    int
}

// Supply is the option bag of analyzeCorrelations.
type CorrelationOptions struct {
	PreviousCounts map[string]int
	Learning       map[string]CorrelationLearningOverride
}

// CorrelationOutcome is the tuple analyzeCorrelations returns.
type CorrelationOutcome struct {
	Results     *CorrelationResults
	TopicCounts map[string]int
}

type correlationOverride struct {
	boosted    []string
	blocked    []string
	suppressed map[string]bool
	feedback   FeedbackStats
	learning   LearningSnapshot
}

// AnalyzeCorrelations mirrors analyzeCorrelations.
func AnalyzeCorrelations(allNews []NewsItem, options CorrelationOptions) CorrelationOutcome {
	if len(allNews) == 0 {
		return CorrelationOutcome{TopicCounts: map[string]int{}}
	}

	results := &CorrelationResults{
		EmergingPatterns:        []EmergingPattern{},
		MomentumSignals:         []MomentumSignal{},
		CrossSourceCorrelations: []CrossSourceCorrelation{},
		PredictiveSignals:       []PredictiveSignal{},
	}

	overrides := make(map[string]correlationOverride, len(correlationTopics))
	for _, topic := range correlationTopics {
		override, ok := options.Learning[topic.id]
		if !ok {
			override = CorrelationLearningOverride{}
		}
		boosted := normalizeTokens(override.BoostedTokens)
		blocked := normalizeTokens(override.BlockedTokens)
		suppressed := normalizeSuppressed(override.SuppressedItemMetaIDs)
		falsePositive := override.FalsePositiveCount
		if falsePositive < 0 {
			falsePositive = 0
		}
		falseNegative := override.FalseNegativeCount
		if falseNegative < 0 {
			falseNegative = 0
		}
		overrides[topic.id] = correlationOverride{
			boosted:    boosted,
			blocked:    blocked,
			suppressed: suppressed,
			feedback:   FeedbackStats{FalsePositive: falsePositive, FalseNegative: falseNegative},
			learning: LearningSnapshot{
				BoostedTokens:   boosted,
				BlockedTokens:   blocked,
				SuppressedCount: len(suppressed),
			},
		}
	}

	topicCounts := map[string]int{}
	topicSources := map[string][]string{}
	topicSourceSeen := map[string]map[string]bool{}
	topicHeadlines := map[string][]SignalHeadline{}

	for _, item := range allNews {
		source := item.Source
		if source == "" {
			source = "Unknown"
		}
		haystack := normalizeForMatch(item)
		lowerHaystack := strings.ToLower(haystack)

		for _, topic := range correlationTopics {
			override := overrides[topic.id]
			if item.ItemMeta != "" && override.suppressed[item.ItemMeta] {
				continue
			}
			matches := false
			for _, pattern := range topic.patterns {
				if pattern.MatchString(haystack) {
					matches = true
					break
				}
			}
			boostedMatch := false
			if len(override.boosted) > 0 {
				for _, token := range override.boosted {
					if strings.Contains(lowerHaystack, token) {
						boostedMatch = true
						break
					}
				}
			}
			if !matches && !boostedMatch {
				continue
			}
			if len(override.blocked) > 0 {
				blocked := false
				for _, token := range override.blocked {
					if strings.Contains(lowerHaystack, token) {
						blocked = true
						break
					}
				}
				if blocked {
					continue
				}
			}

			topicCounts[topic.id]++
			if topicSourceSeen[topic.id] == nil {
				topicSourceSeen[topic.id] = map[string]bool{}
			}
			if !topicSourceSeen[topic.id][source] {
				topicSourceSeen[topic.id][source] = true
				topicSources[topic.id] = append(topicSources[topic.id], source)
			}

			if len(topicHeadlines[topic.id]) < 5 {
				topicHeadlines[topic.id] = append(topicHeadlines[topic.id], SignalHeadline{
					Title:    item.Title,
					TitleZh:  item.TitleZh,
					Link:     item.Link,
					Source:   source,
					ItemMeta: item.ItemMeta,
				})
			}
		}
	}

	previousCounts := options.PreviousCounts
	for _, topic := range correlationTopics {
		override := overrides[topic.id]
		count := topicCounts[topic.id]
		sources := topicSources[topic.id]
		if sources == nil {
			sources = []string{}
		}
		headlines := topicHeadlines[topic.id]
		if headlines == nil {
			headlines = []SignalHeadline{}
		}
		oldCount := 0
		if previousCounts != nil {
			oldCount = previousCounts[topic.id]
		}
		delta := count - oldCount
		feedback := override.feedback
		learning := override.learning

		if count >= 3 {
			level := "emerging"
			if count >= 8 {
				level = "high"
			} else if count >= 5 {
				level = "elevated"
			}
			results.EmergingPatterns = append(results.EmergingPatterns, EmergingPattern{
				ID: topic.id, Name: formatTopicName(topic.id), Category: topic.category,
				Count: count, Level: level, Sources: sources, Headlines: headlines,
				Feedback: &feedback, Learning: &learning,
			})
		}
		if delta >= 2 || (count >= 3 && delta >= 1) {
			momentum := "stable"
			if delta >= 4 {
				momentum = "surging"
			} else if delta >= 2 {
				momentum = "rising"
			}
			results.MomentumSignals = append(results.MomentumSignals, MomentumSignal{
				ID: topic.id, Name: formatTopicName(topic.id), Category: topic.category,
				Current: count, Delta: delta, Momentum: momentum, Headlines: headlines,
				Feedback: &feedback, Learning: &learning,
			})
		}
		if len(sources) >= 3 {
			level := "emerging"
			if len(sources) >= 5 {
				level = "high"
			} else if len(sources) >= 4 {
				level = "elevated"
			}
			results.CrossSourceCorrelations = append(results.CrossSourceCorrelations, CrossSourceCorrelation{
				ID: topic.id, Name: formatTopicName(topic.id), Category: topic.category,
				SourceCount: len(sources), Sources: sources, Level: level, Headlines: headlines,
				Feedback: &feedback, Learning: &learning,
			})
		}
		score := count*2 + len(sources)*3 + delta*5
		if score >= 15 {
			confidence := int(math.Min(95, math.Round(float64(score)*1.5)))
			prediction := getPrediction(topic.id, topic.category, count)
			level := "low"
			if confidence >= 70 {
				level = "high"
			} else if confidence >= 50 {
				level = "medium"
			}
			results.PredictiveSignals = append(results.PredictiveSignals, PredictiveSignal{
				ID: topic.id, Name: formatTopicName(topic.id), Category: topic.category,
				Score: float64(score), Confidence: confidence, Prediction: prediction,
				Level: level, Headlines: headlines, Feedback: &feedback, Learning: &learning,
			})
		}
	}

	sort.SliceStable(results.EmergingPatterns, func(i, j int) bool {
		return results.EmergingPatterns[i].Count > results.EmergingPatterns[j].Count
	})
	sort.SliceStable(results.MomentumSignals, func(i, j int) bool {
		return results.MomentumSignals[i].Delta > results.MomentumSignals[j].Delta
	})
	sort.SliceStable(results.CrossSourceCorrelations, func(i, j int) bool {
		return results.CrossSourceCorrelations[i].SourceCount > results.CrossSourceCorrelations[j].SourceCount
	})
	sort.SliceStable(results.PredictiveSignals, func(i, j int) bool {
		return results.PredictiveSignals[i].Score > results.PredictiveSignals[j].Score
	})

	return CorrelationOutcome{Results: results, TopicCounts: topicCounts}
}

// GetCorrelationSummary mirrors getCorrelationSummary.
func GetCorrelationSummary(results *CorrelationResults) CorrelationSummary {
	if results == nil {
		return CorrelationSummary{TotalSignals: 0, Status: "NO DATA"}
	}
	total := len(results.EmergingPatterns) + len(results.MomentumSignals) + len(results.PredictiveSignals)
	status := "MONITORING"
	if total > 0 {
		status = itoa(total) + " SIGNALS"
	}
	return CorrelationSummary{TotalSignals: total, Status: status}
}

func formatTopicName(id string) string {
	return formatIDTitle(id)
}

func normalizeForMatch(item NewsItem) string {
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
	return strings.TrimSpace(strings.Join(parts, " "))
}

func normalizeTokens(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.ToLower(strings.TrimSpace(value))
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= 12 {
			break
		}
	}
	return out
}

func normalizeSuppressed(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out[trimmed] = true
		}
	}
	return out
}

func getPrediction(topicID, category string, count int) string {
	if topicID == "tariffs" && count >= 4 {
		return "Market volatility likely in next 24-48h"
	}
	if topicID == "fed-rates" {
		return "Expect increased financial sector coverage"
	}
	if strings.Contains(topicID, "china") || strings.Contains(topicID, "russia") {
		return "Geopolitical escalation narrative forming"
	}
	if topicID == "layoffs" {
		return "Employment concerns may dominate news cycle"
	}
	if category == "Conflict" {
		return "Breaking developments likely within hours"
	}
	return "Topic gaining mainstream traction"
}
