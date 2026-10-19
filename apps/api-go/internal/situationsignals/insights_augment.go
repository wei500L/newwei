package situationsignals

import (
	"context"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

// augmentInsights mirrors SituationMonitorMonitorsService.augmentInsights:
// the candidate set is built from display headlines, alerts and situation
// panels, then matched by the shared monitor matcher. Candidate keys and field
// mappings are copied verbatim so a Go match is indistinguishable from NestJS.
func (s *insightsService) augmentInsights(ctx context.Context, orgID, userID string, response *insightsResponse) error {
	candidates := make([]monitorCandidate, 0)
	if response.Headlines != nil {
		for _, category := range analysis.Categories {
			bucket := response.Headlines.Bucket(category)
			if bucket == nil {
				continue
			}
			for _, entry := range *bucket {
				candidates = append(candidates, headlineMonitorCandidate(entry, "headline", string(category)))
			}
		}
	}
	if response.Alerts != nil {
		for _, entry := range *response.Alerts {
			candidates = append(candidates, headlineMonitorCandidate(entry.Headline, "alert", "alert:"+string(entry.Category)))
		}
	}
	if response.Situations != nil {
		for _, panel := range *response.Situations {
			for _, entry := range panel.Headlines {
				candidates = append(candidates, monitorCandidate{
					ItemKey:    insightsItemKey("", entry.Link, entry.Title),
					ItemType:   "situation",
					Title:      entry.Title,
					TitleZh:    entry.TitleZh,
					Link:       entry.Link,
					Source:     entry.Source,
					Timestamp:  float64(entry.Timestamp),
					Category:   "situation:" + panel.ID,
					Topics:     []string{},
					Entities:   []string{},
					GeoTexts:   []string{},
					ExtraTexts: []string{panel.Title, panel.Subtitle},
				})
			}
		}
	}
	matches, err := s.signals.matchCandidates(ctx, orgID, userID, candidates)
	if err != nil {
		return err
	}
	if matches == nil {
		matches = []matchResult{}
	}
	response.MonitorMatches = matches
	return nil
}

func headlineMonitorCandidate(entry analysis.Headline, itemType, category string) monitorCandidate {
	geoTexts := []string{}
	if entry.Location != "" {
		geoTexts = append(geoTexts, entry.Location)
	}
	extraTexts := entry.KeyPoints
	if extraTexts == nil {
		extraTexts = []string{}
	}
	topics := entry.Topics
	if topics == nil {
		topics = []string{}
	}
	entities := entry.Entities
	if entities == nil {
		entities = []string{}
	}
	return monitorCandidate{
		ItemKey:    insightsItemKey(entry.ItemMetaID, entry.Link, entry.Title),
		ItemType:   itemType,
		ItemMetaID: entry.ItemMetaID,
		Title:      entry.Title,
		TitleZh:    entry.TitleZh,
		Summary:    entry.Summary,
		SummaryZh:  entry.SummaryZh,
		Link:       entry.Link,
		Source:     entry.Source,
		Timestamp:  float64(entry.Timestamp),
		Category:   category,
		Topics:     topics,
		Entities:   entities,
		Location:   entry.Location,
		GeoTexts:   geoTexts,
		ExtraTexts: extraTexts,
	}
}

// insightsItemKey mirrors itemKey(): a trimmed itemMetaId wins, otherwise the
// trimmed link and title are joined even when both are empty.
func insightsItemKey(itemMetaID, link, title string) string {
	if trimmed := strings.TrimSpace(itemMetaID); trimmed != "" {
		return "id:" + trimmed
	}
	return "link:" + strings.TrimSpace(link) + "::" + strings.TrimSpace(title)
}
