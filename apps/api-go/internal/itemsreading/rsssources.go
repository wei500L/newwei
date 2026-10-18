package itemsreading

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// newsSourceSeedConfig is the typed view of NewsSource.config.seed.
type newsSourceSeedConfig struct {
	Mode    *string `json:"mode"`
	FeedURL *string `json:"feedUrl"`
}

// newsSourceConfig is the typed view of the NewsSource.config JSON column.
type newsSourceConfig struct {
	Seed *newsSourceSeedConfig `json:"seed"`
}

// RssSources ports ItemsSearchService.listRssSourcesForReading. It only reads
// configuration: it never requests the feed URL, never starts a crawl and never
// probes the site.
func (s *Service) RssSources(
	ctx context.Context,
	orgID string,
	windowDays *int,
	onlyWithItems *bool,
) ([]RssSourceOption, error) {
	days := RssSourceWindowDaysDefault
	if windowDays != nil {
		days = ClampInt(*windowDays, RssSourceWindowDaysMin, RssSourceWindowDaysMax)
	}
	// onlyWithItems defaults to true, so a zero-count source is hidden unless the
	// caller explicitly passes false.
	includeEmpty := false
	if onlyWithItems != nil {
		includeEmpty = !*onlyWithItems
	}
	since := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)

	rows, err := s.mysql.RssNewsSources(ctx, orgID)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id       string
		name     string
		language *string
		siteURL  string
		feedURL  string
	}
	candidates := make([]candidate, 0, len(rows))
	for _, row := range rows {
		if !row.Config.Valid() {
			continue
		}
		var config newsSourceConfig
		if err := json.Unmarshal(row.Config.Bytes(), &config); err != nil {
			continue
		}
		if config.Seed == nil {
			continue
		}
		mode := ""
		if config.Seed.Mode != nil {
			mode = strings.ToLower(strings.TrimSpace(*config.Seed.Mode))
		}
		if mode != "rss" {
			continue
		}
		feedURL := ""
		if config.Seed.FeedURL != nil {
			feedURL = strings.TrimSpace(*config.Seed.FeedURL)
		}
		siteURL := strings.TrimSpace(row.URL)
		if feedURL == "" {
			feedURL = siteURL
		}
		if feedURL == "" || siteURL == "" {
			continue
		}
		candidates = append(candidates, candidate{
			id:       row.ID,
			name:     row.Name,
			language: row.Language,
			siteURL:  siteURL,
			feedURL:  feedURL,
		})
	}
	if len(candidates) == 0 {
		return []RssSourceOption{}, nil
	}
	sourceIDs := make([]string, 0, len(candidates))
	for _, entry := range candidates {
		sourceIDs = append(sourceIDs, entry.id)
	}

	processedStats, err := s.mongo.RssWindowStats(ctx, orgID, sourceIDs, since)
	if err != nil {
		return nil, err
	}
	articleStats, err := s.mysql.ArticleWindowStats(ctx, orgID, sourceIDs, since)
	if err != nil {
		return nil, err
	}

	options := make([]RssSourceOption, 0, len(candidates))
	for _, entry := range candidates {
		processed := processedStats[entry.id]
		article := articleStats[entry.id]
		count := processed.ItemCountWindow
		if article.ItemCountWindow > count {
			count = article.ItemCountWindow
		}
		latest := latestOf(processed.LatestItemAt, article.LatestItemAt)
		if !includeEmpty && count <= 0 {
			continue
		}
		option := RssSourceOption{
			ID:              entry.id,
			Name:            entry.name,
			Language:        entry.language,
			SiteURL:         entry.siteURL,
			FeedURL:         entry.feedURL,
			ItemCountWindow: count,
		}
		if latest != nil {
			formatted := FormatISOTime(*latest)
			option.LatestItemAt = &formatted
		}
		options = append(options, option)
	}

	sortRssSourceOptions(options)
	return options, nil
}

// latestOf returns the newest of two optional timestamps.
func latestOf(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if right.After(*left) {
		return right
	}
	return left
}

// sortRssSourceOptions orders by itemCountWindow DESC, latestItemAt DESC, then
// name localeCompare. A source with a timestamp sorts before one without.
func sortRssSourceOptions(options []RssSourceOption) {
	sort.SliceStable(options, func(i, j int) bool {
		if options[i].ItemCountWindow != options[j].ItemCountWindow {
			return options[i].ItemCountWindow > options[j].ItemCountWindow
		}
		left, right := options[i].LatestItemAt, options[j].LatestItemAt
		switch {
		case left != nil && right != nil:
			return *right < *left
		case left != nil:
			return true
		case right != nil:
			return false
		default:
			return localeCompare(options[i].Name, options[j].Name) < 0
		}
	})
}
