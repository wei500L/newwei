package dashboardwarmap

import (
	"encoding/json"
	"math"
	"strconv"
	"time"
)

type warEvent struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	NameZh       string  `json:"nameZh,omitempty"`
	Lat          float64 `json:"lat"`
	Lng          float64 `json:"lng"`
	Severity     string  `json:"severity"`
	LatestAt     string  `json:"latestAt,omitempty"`
	DerivedScore float64 `json:"derivedScore"`
	Value        float64 `json:"value"`
	AlertScore   float64 `json:"alertScore"`
	AlertCount   int     `json:"alertCount"`
	NewsCount    int     `json:"newsCount"`
	IsCluster    bool    `json:"isCluster,omitempty"`
	ClusterID    *int    `json:"clusterId,omitempty"`
	ClusterCount *int    `json:"clusterCount,omitempty"`
}

type newsMarker struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	TitleZh       string  `json:"titleZh,omitempty"`
	URL           *string `json:"-"`
	URLPresent    bool    `json:"-"`
	Location      string  `json:"location"`
	LocationZh    string  `json:"locationZh,omitempty"`
	Lat           float64 `json:"lat"`
	Lng           float64 `json:"lng"`
	PublishedAt   string  `json:"publishedAt,omitempty"`
	IngestedAt    string  `json:"ingestedAt,omitempty"`
	DisplayName   string  `json:"displayName,omitempty"`
	DisplayNameZh string  `json:"displayNameZh,omitempty"`
	GeoSource     string  `json:"geoSource"`
	IsCluster     bool    `json:"isCluster,omitempty"`
	ClusterID     *int    `json:"clusterId,omitempty"`
	ClusterCount  *int    `json:"clusterCount,omitempty"`
}

type eventsResponse struct {
	Events    []warEvent `json:"events"`
	UpdatedAt string     `json:"updatedAt,omitempty"`
	Clustered bool       `json:"clustered"`
}

type markersResponse struct {
	Markers   []newsMarker `json:"markers"`
	UpdatedAt string       `json:"updatedAt,omitempty"`
	Clustered bool         `json:"clustered"`
}

func (m newsMarker) MarshalJSON() ([]byte, error) {
	payload := map[string]any{
		"id":        m.ID,
		"title":     m.Title,
		"location":  m.Location,
		"lat":       m.Lat,
		"lng":       m.Lng,
		"geoSource": m.GeoSource,
	}
	if m.TitleZh != "" {
		payload["titleZh"] = m.TitleZh
	}
	if m.URLPresent {
		if m.URL == nil {
			payload["url"] = nil
		} else {
			payload["url"] = *m.URL
		}
	}
	if m.LocationZh != "" {
		payload["locationZh"] = m.LocationZh
	}
	if m.PublishedAt != "" {
		payload["publishedAt"] = m.PublishedAt
	}
	if m.IngestedAt != "" {
		payload["ingestedAt"] = m.IngestedAt
	}
	if m.DisplayName != "" {
		payload["displayName"] = m.DisplayName
	}
	if m.DisplayNameZh != "" {
		payload["displayNameZh"] = m.DisplayNameZh
	}
	if m.IsCluster {
		payload["isCluster"] = true
	}
	if m.ClusterID != nil {
		payload["clusterId"] = *m.ClusterID
	}
	if m.ClusterCount != nil {
		payload["clusterCount"] = *m.ClusterCount
	}
	return json.Marshal(payload)
}

type alertRow struct {
	TriggeredAt time.Time
	Severity    string
	Context     map[string]any
}

type articlePoint struct {
	Location    string
	ProcessedAt *time.Time
	EventAt     *time.Time
}

type markerRow struct {
	ID          string
	Title       string
	Location    string
	Entities    any
	URL         *string
	PublishedAt *time.Time
	EventAt     *time.Time
	SortAt      *time.Time
	ProcessedAt *time.Time
	CrawlAt     *time.Time
	TitleGuess  string
}

type mongoRow struct {
	ID          string
	Location    string
	Entities    any
	Title       string
	URL         *string
	SortAt      *time.Time
	IngestedAt  *time.Time
	CreatedAt   *time.Time
	PublishedAt *time.Time
}

type cleanedEntity struct {
	Name       string
	Type       string
	Confidence float64
}

func severityRank(value string) int {
	switch value {
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func severityByRank(rank int) string {
	switch rank {
	case 3:
		return "high"
	case 2:
		return "medium"
	case 1:
		return "low"
	default:
		return "low"
	}
}

func jsFixed2(value float64) float64 {
	rounded := math.Round(value*100) / 100
	return rounded
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func parseMillis(value string) int64 {
	if value == "" {
		return 0
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

func millisISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return iso(time.UnixMilli(ms).UTC())
}

func strconvItoa(n int) string {
	return strconv.FormatInt(int64(n), 10)
}

func later(current *time.Time, next time.Time) *time.Time {
	if current == nil || next.After(*current) {
		copied := next
		return &copied
	}
	return current
}
