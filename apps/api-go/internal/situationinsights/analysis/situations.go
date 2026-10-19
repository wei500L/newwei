package analysis

import (
	"sort"
	"strings"
)

type situationPanelConfig struct {
	id               string
	title            string
	subtitle         string
	matchKeywords    []string
	criticalKeywords []string
}

// situationPanels mirrors SITUATION_PANELS in declaration order.
var situationPanels = []situationPanelConfig{
	{"venezuela", "Venezuela Watch", "Humanitarian crisis monitoring", []string{"venezuela", "maduro"}, []string{"maduro", "caracas", "venezuela", "guaido"}},
	{"greenland", "Greenland Watch", "Arctic geopolitics monitoring", []string{"greenland", "arctic"}, []string{"greenland", "arctic", "nuuk", "denmark"}},
	{"iran", "Iran Crisis", "Revolution protests, regime instability & nuclear program", []string{"iran", "tehran", "irgc"}, []string{"protest", "uprising", "revolution", "crackdown", "killed", "nuclear", "strike", "attack", "irgc", "khamenei"}},
}

// BuildSituations mirrors buildSituations. nowMS is the request clock in Unix
// milliseconds; the caller passes time.Now().UnixMilli().
func BuildSituations(news []NewsItem, nowMS int64) []SituationPanel {
	dayAgo := nowMS - 24*60*60*1000
	panels := make([]SituationPanel, 0, len(situationPanels))
	for _, panel := range situationPanels {
		matchKeywords := make([]string, 0, len(panel.matchKeywords))
		for _, keyword := range panel.matchKeywords {
			matchKeywords = append(matchKeywords, strings.ToLower(keyword))
		}
		criticalKeywords := make([]string, 0, len(panel.criticalKeywords))
		for _, keyword := range panel.criticalKeywords {
			criticalKeywords = append(criticalKeywords, strings.ToLower(keyword))
		}
		matched := make([]NewsItem, 0)
		for _, item := range news {
			title := strings.ToLower(item.Title)
			for _, keyword := range matchKeywords {
				if strings.Contains(title, keyword) {
					matched = append(matched, item)
					break
				}
			}
		}
		sort.SliceStable(matched, func(i, j int) bool { return matched[i].Timestamp > matched[j].Timestamp })
		recentCount := 0
		for _, item := range matched {
			if item.Timestamp >= dayAgo {
				recentCount++
			}
		}
		hasCritical := false
		for _, item := range matched {
			title := strings.ToLower(item.Title)
			for _, keyword := range criticalKeywords {
				if strings.Contains(title, keyword) {
					hasCritical = true
					break
				}
			}
			if hasCritical {
				break
			}
		}
		level := "monitoring"
		if hasCritical || recentCount >= 3 {
			level = "critical"
		} else if recentCount >= 1 {
			level = "elevated"
		}
		status := "MONITORING"
		if level == "critical" {
			status = "CRITICAL"
		} else if level == "elevated" {
			status = "ELEVATED"
		}
		headlines := make([]HeadlineRef, 0, 8)
		for _, item := range matched {
			if len(headlines) >= 8 {
				break
			}
			headlines = append(headlines, HeadlineRef{
				Title: item.Title, Link: item.Link, Source: item.Source, Timestamp: item.Timestamp,
			})
		}
		panels = append(panels, SituationPanel{
			ID: panel.id, Title: panel.title, Subtitle: panel.subtitle,
			Level: level, Status: status, Headlines: headlines,
		})
	}
	return panels
}
