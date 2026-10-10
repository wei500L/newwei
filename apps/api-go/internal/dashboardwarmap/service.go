package dashboardwarmap

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strings"
	"time"
)

type articleReader interface {
	Alerts(ctx context.Context, orgID string, start, end time.Time) ([]alertRow, error)
	EventArticles(ctx context.Context, orgID string, start, end time.Time) ([]articlePoint, error)
	MarkerArticles(ctx context.Context, orgID string, start, end time.Time) ([]markerRow, error)
}

type locationReader interface {
	Locations(ctx context.Context, orgID string, start, end time.Time, limit int) ([]mongoRow, error)
}

// Service 读取告警、MySQL 新闻，并在 MySQL 新闻为空时回退 Mongo。
// orgID 只能由调用方传入，实现不读请求参数。
type Service struct {
	articles articleReader
	mongo    locationReader
	cache    blobCache
	geo      geocoder
	words    translator
	index    *geoIndex
	tracks   transportReader
	snaps    snapshotReader
	sky      openskyViewport
}

func (s *Service) Events(ctx context.Context, orgID string, start, end time.Time, opt viewOptions) (eventsResponse, error) {
	alerts, articles, err := s.loadEventInputs(ctx, orgID, start, end)
	if err != nil {
		return eventsResponse{}, err
	}
	var fallback []mongoRow
	if len(articles) == 0 && s.mongo != nil {
		rows, mongoErr := s.mongo.Locations(ctx, orgID, start, end, eventArticleLimit)
		if mongoErr != nil {
			log.Printf("dashboard war map: event mongo fallback failed")
		} else {
			fallback = rows
		}
	}
	body, names := assembleEvents(alerts, articles, fallback, s.world())
	if opt.Translate && len(body.Events) > 0 && s.words != nil {
		applyEventTranslations(body.Events, s.words.ToZH(ctx, names))
	}
	body.Events = clusterEvents(body.Events, opt)
	if body.Events == nil {
		body.Events = []warEvent{}
	}
	body.Clustered = opt.Cluster
	return body, nil
}

func (s *Service) Markers(ctx context.Context, orgID string, start, end time.Time, opt viewOptions) (markersResponse, error) {
	rows, err := s.markerRows(ctx, orgID, start, end)
	if err != nil {
		return markersResponse{}, err
	}
	budget := 3
	markers := make([]newsMarker, 0)
	var updated *time.Time
	texts := make([]string, 0)
	for _, row := range rows {
		marker, latest, ok, err := s.placeMarker(ctx, row, &budget)
		if err != nil {
			return markersResponse{}, err
		}
		if !ok {
			continue
		}
		markers = append(markers, marker)
		if latest != nil {
			updated = later(updated, *latest)
		}
		texts = append(texts, marker.Title, marker.Location, marker.DisplayName)
	}
	if opt.Translate && len(markers) > 0 && s.words != nil {
		applyMarkerTranslations(markers, s.words.ToZH(ctx, uniqTexts(texts)))
	}
	markers = clusterMarkers(markers, opt)
	if markers == nil {
		markers = []newsMarker{}
	}
	body := markersResponse{Markers: markers, Clustered: opt.Cluster}
	if updated != nil {
		body.UpdatedAt = iso(*updated)
	}
	return body, nil
}

func (s *Service) world() *geoIndex {
	if s.index != nil {
		return s.index
	}
	return worldIndex()
}

func (s *Service) loadEventInputs(ctx context.Context, orgID string, start, end time.Time) ([]alertRow, []articlePoint, error) {
	type alertsResult struct {
		rows []alertRow
		err  error
	}
	type articleResult struct {
		rows []articlePoint
		err  error
	}
	alertsCh := make(chan alertsResult, 1)
	articlesCh := make(chan articleResult, 1)
	go func() {
		rows, err := s.articles.Alerts(ctx, orgID, start, end)
		alertsCh <- alertsResult{rows: rows, err: err}
	}()
	go func() {
		rows, err := s.cachedEventArticles(ctx, orgID, start, end)
		articlesCh <- articleResult{rows: rows, err: err}
	}()
	alerts := <-alertsCh
	articles := <-articlesCh
	if alerts.err != nil {
		return nil, nil, alerts.err
	}
	if articles.err != nil {
		return nil, nil, articles.err
	}
	if alerts.rows == nil {
		alerts.rows = []alertRow{}
	}
	if articles.rows == nil {
		articles.rows = []articlePoint{}
	}
	return alerts.rows, articles.rows, nil
}

func (s *Service) cachedEventArticles(ctx context.Context, orgID string, start, end time.Time) ([]articlePoint, error) {
	key := dashboardCacheKey("war-map-events", orgID, start, end)
	rows, err := loadCached(ctx, s.cache, key, func() ([]cachedEventRow, []byte, error) {
		loaded, err := s.articles.EventArticles(ctx, orgID, start, end)
		if err != nil {
			return nil, nil, err
		}
		encoded := encodeEventRows(loaded)
		body, err := json.Marshal(encoded)
		if err != nil {
			return nil, nil, err
		}
		return encoded, body, nil
	})
	if err != nil {
		return nil, err
	}
	return decodeEventRows(rows), nil
}

func (s *Service) markerRows(ctx context.Context, orgID string, start, end time.Time) ([]markerRow, error) {
	key := dashboardCacheKey("war-map-news-markers", orgID, start, end)
	cached, err := loadCached(ctx, s.cache, key, func() ([]cachedMarkerRow, []byte, error) {
		loaded, err := s.articles.MarkerArticles(ctx, orgID, start, end)
		if err != nil {
			return nil, nil, err
		}
		encoded := encodeMarkerRows(loaded)
		body, err := json.Marshal(encoded)
		if err != nil {
			return nil, nil, err
		}
		return encoded, body, nil
	})
	if err != nil {
		return nil, err
	}
	rows := decodeMarkerRows(cached)
	if len(rows) > 0 || s.mongo == nil {
		return rows, nil
	}
	fallback, mongoErr := s.mongo.Locations(ctx, orgID, start, end, markerArticleLimit)
	if mongoErr != nil {
		log.Printf("dashboard war map: marker mongo fallback failed")
		return []markerRow{}, nil
	}
	out := make([]markerRow, 0, len(fallback))
	for _, row := range fallback {
		out = append(out, markerRow{
			ID:          row.ID,
			Title:       row.Title,
			Location:    row.Location,
			Entities:    row.Entities,
			URL:         row.URL,
			PublishedAt: row.PublishedAt,
			SortAt:      firstTime(row.PublishedAt, row.SortAt, row.IngestedAt, row.CreatedAt),
			ProcessedAt: firstTime(row.SortAt, row.IngestedAt, row.CreatedAt),
			CrawlAt:     row.IngestedAt,
		})
	}
	return out, nil
}

func (s *Service) placeMarker(ctx context.Context, row markerRow, budget *int) (newsMarker, *time.Time, bool, error) {
	location := strings.TrimSpace(row.Location)
	if location == "" {
		return newsMarker{}, nil, false, nil
	}
	entities := normalizeEntities(row.Entities)
	country := resolveCountry(location, entities)
	direct := normalizeCountryCode(location)
	alpha2 := ""
	name := ""
	if country != "" {
		alpha2 = countryAlpha2(country)
		name = countryName(country)
	}
	candidates := geocodeCandidates(location, entities, name)
	var hit *geoHit
	var err error
	if s.geo != nil {
		hit, err = s.geo.Resolve(ctx, candidates, alpha2, false)
		if err != nil {
			return newsMarker{}, nil, false, err
		}
		if hit == nil && budget != nil && *budget > 0 {
			*budget--
			hit, err = s.geo.Resolve(ctx, candidates, alpha2, true)
			if err != nil {
				return newsMarker{}, nil, false, err
			}
		}
	}
	lat, lng := 0.0, 0.0
	display := ""
	source := "geocoded"
	placed := false
	if hit != nil && !math.IsNaN(hit.Lat) && !math.IsNaN(hit.Lng) {
		lat, lng, display, placed = hit.Lat, hit.Lng, hit.DisplayName, true
	}
	if !placed && direct != "" {
		if point, ok := s.world().get(direct); ok {
			lat, lng, display, source, placed = point.Lat, point.Lng, point.Name, "fallback-country", true
		}
	}
	if !placed || math.IsNaN(lat) || math.IsNaN(lng) || math.Abs(lat) > 90 || math.Abs(lng) > 180 {
		return newsMarker{}, nil, false, nil
	}
	title := strings.TrimSpace(row.Title)
	if title == "" {
		title = strings.TrimSpace(row.TitleGuess)
	}
	if title == "" && row.URL != nil {
		title = strings.TrimSpace(*row.URL)
	}
	if title == "" {
		title = location
	}
	marker := newsMarker{
		ID:         row.ID,
		Title:      title,
		URL:        row.URL,
		URLPresent: true,
		Location:   location,
		Lat:        lat,
		Lng:        lng,
		GeoSource:  source,
	}
	if row.PublishedAt != nil {
		marker.PublishedAt = iso(*row.PublishedAt)
	}
	if row.CrawlAt != nil {
		marker.IngestedAt = iso(*row.CrawlAt)
	}
	if display != "" {
		marker.DisplayName = display
	}
	latest := firstTime(row.SortAt, row.PublishedAt, row.CrawlAt, row.ProcessedAt)
	return marker, latest, true, nil
}

func encodeEventRows(rows []articlePoint) []cachedEventRow {
	out := make([]cachedEventRow, 0, len(rows))
	for _, row := range rows {
		item := cachedEventRow{ProcessedAt: isoPtr(row.ProcessedAt), EventAt: isoPtr(row.EventAt)}
		if row.Location != "" {
			location := row.Location
			item.Location = &location
		}
		out = append(out, item)
	}
	if out == nil {
		out = []cachedEventRow{}
	}
	return out
}

func decodeEventRows(rows []cachedEventRow) []articlePoint {
	out := make([]articlePoint, 0, len(rows))
	for _, row := range rows {
		item := articlePoint{ProcessedAt: parseISOPtr(row.ProcessedAt), EventAt: parseISOPtr(row.EventAt)}
		if row.Location != nil {
			item.Location = *row.Location
		}
		out = append(out, item)
	}
	return out
}

func encodeMarkerRows(rows []markerRow) []cachedMarkerRow {
	out := make([]cachedMarkerRow, 0, len(rows))
	for _, row := range rows {
		entities, _ := json.Marshal(row.Entities)
		if len(entities) == 0 {
			entities = []byte("null")
		}
		item := cachedMarkerRow{
			ID:          row.ID,
			PublishedAt: isoPtr(row.PublishedAt),
			EventAt:     isoPtr(row.EventAt),
			ProcessedAt: isoPtr(row.ProcessedAt),
			Entities:    entities,
			Article: cachedMarkerArticle{
				URL:     row.URL,
				CrawlAt: isoPtr(row.CrawlAt),
			},
		}
		if row.Title != "" {
			title := row.Title
			item.Title = &title
		}
		if row.Location != "" {
			location := row.Location
			item.Location = &location
		}
		if row.TitleGuess != "" {
			guess := row.TitleGuess
			item.Article.TitleGuess = &guess
		}
		out = append(out, item)
	}
	if out == nil {
		out = []cachedMarkerRow{}
	}
	return out
}

func decodeMarkerRows(rows []cachedMarkerRow) []markerRow {
	out := make([]markerRow, 0, len(rows))
	for _, row := range rows {
		item := markerRow{
			ID:          row.ID,
			URL:         row.Article.URL,
			PublishedAt: parseISOPtr(row.PublishedAt),
			EventAt:     parseISOPtr(row.EventAt),
			ProcessedAt: parseISOPtr(row.ProcessedAt),
			CrawlAt:     parseISOPtr(row.Article.CrawlAt),
		}
		if row.Title != nil {
			item.Title = *row.Title
		}
		if row.Location != nil {
			item.Location = *row.Location
		}
		if row.Article.TitleGuess != nil {
			item.TitleGuess = *row.Article.TitleGuess
		}
		if len(row.Entities) > 0 && string(row.Entities) != "null" {
			var entities any
			if json.Unmarshal(row.Entities, &entities) == nil {
				item.Entities = entities
			}
		}
		item.SortAt = firstTime(item.EventAt, item.PublishedAt, item.CrawlAt, item.ProcessedAt)
		out = append(out, item)
	}
	return out
}

func isoPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	text := iso(*value)
	return &text
}

func parseISOPtr(value *string) *time.Time {
	if value == nil || *value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil
	}
	copied := parsed.UTC()
	return &copied
}
