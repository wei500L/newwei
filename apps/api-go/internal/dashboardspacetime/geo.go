package dashboardspacetime

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
)

type badRequest struct {
	message string
}

func (e *badRequest) Error() string {
	return e.message
}

func errBad(message string) error {
	return &badRequest{message: message}
}

type placeResolver interface {
	Resolve(ctx context.Context, candidates []string, alpha2 string, network bool) (*dashboardwarmap.Place, error)
}

type Service struct {
	articles articleReader
	items    itemReader
	snaps    snapshotCache
	geo      placeResolver
}

type sentimentCounts struct {
	Positive int `json:"positive"`
	Neutral  int `json:"neutral"`
	Negative int `json:"negative"`
	Unknown  int `json:"unknown"`
}

func (s *sentimentCounts) add(label string) {
	switch label {
	case "positive":
		s.Positive++
	case "neutral":
		s.Neutral++
	case "negative":
		s.Negative++
	default:
		s.Unknown++
	}
}

func (s *sentimentCounts) merge(other sentimentCounts) {
	s.Positive += other.Positive
	s.Neutral += other.Neutral
	s.Negative += other.Negative
	s.Unknown += other.Unknown
}

type bucketJSON struct {
	BucketStart string          `json:"bucketStart"`
	Total       int             `json:"total"`
	Sentiment   sentimentCounts `json:"sentiment"`
}

type heatPointJSON struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Lat       float64          `json:"lat"`
	Lng       float64          `json:"lng"`
	Heat      json.Number      `json:"heat"`
	Total     int              `json:"total"`
	Sentiment sentimentCounts  `json:"sentiment"`
	Buckets   *[]bucketJSON    `json:"buckets,omitempty"`
}

type heatResponse struct {
	Points     []heatPointJSON `json:"points"`
	SnapshotID string          `json:"snapshotId,omitempty"`
	UpdatedAt  string          `json:"updatedAt,omitempty"`
}

type geoArticleJSON struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	URL         *string `json:"url"`
	SourceLabel *string `json:"sourceLabel"`
	Location    string  `json:"location"`
	PublishedAt *string `json:"publishedAt,omitempty"`
	IngestedAt  *string `json:"ingestedAt,omitempty"`
	ProcessedAt *string `json:"processedAt,omitempty"`
	Sentiment   *string `json:"sentiment,omitempty"`
}

type geoArticlesResponse struct {
	PointID     string           `json:"pointId"`
	BucketStart string           `json:"bucketStart,omitempty"`
	HasMore     bool             `json:"hasMore"`
	Articles    []geoArticleJSON `json:"articles"`
	UpdatedAt   string           `json:"updatedAt,omitempty"`
}

type candidateAgg struct {
	order  []string
	counts map[string]int
}

func newCandidates() *candidateAgg {
	return &candidateAgg{counts: map[string]int{}}
}

func (c *candidateAgg) add(text string) {
	if _, ok := c.counts[text]; !ok {
		c.order = append(c.order, text)
		c.counts[text] = 0
	}
	c.counts[text]++
}

func (c *candidateAgg) list(groupKey string) []string {
	type pair struct {
		text  string
		count int
	}
	items := make([]pair, 0, len(c.order))
	for _, text := range c.order {
		items = append(items, pair{text: text, count: c.counts[text]})
	}
	sort.SliceStable(items, func(i, j int) bool {
		left, right := jsLen(items[i].text), jsLen(items[j].text)
		if left != right {
			return left > right
		}
		if items[i].count != items[j].count {
			return items[i].count > items[j].count
		}
		return localeCompare(items[i].text, items[j].text) < 0
	})
	out := make([]string, 0, len(items)+1)
	seen := map[string]struct{}{}
	for _, item := range items {
		if _, ok := seen[item.text]; ok {
			continue
		}
		seen[item.text] = struct{}{}
		out = append(out, item.text)
	}
	if groupKey != "" {
		if _, ok := seen[groupKey]; !ok {
			out = append(out, groupKey)
		}
	}
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func (s *Service) locate(ctx context.Context, candidates []string, budget *int) (float64, float64, string, bool, error) {
	if len(candidates) == 0 {
		return 0, 0, "", false, nil
	}
	countryHint := ""
	for _, candidate := range candidates {
		if code := dashboardwarmap.CountryCodeFromText(candidate); code != "" {
			countryHint = code
			break
		}
	}
	direct := dashboardwarmap.CanonicalCountry(candidates[0])
	country := countryHint
	if country == "" {
		country = direct
	}
	alpha2 := ""
	if country != "" {
		alpha2 = dashboardwarmap.CountryAlpha2(country)
	}
	var lat, lng float64
	name := ""
	found := false
	if direct != "" {
		if place, ok := dashboardwarmap.CountryCenter(direct); ok {
			lat, lng, name = place.Lat, place.Lng, place.Name
			found = true
		}
	}
	if !found {
		if s.geo == nil {
			return 0, 0, "", false, errors.New("geocoder is not configured")
		}
		hit, err := s.geo.Resolve(ctx, candidates, alpha2, false)
		if err != nil {
			return 0, 0, "", false, err
		}
		if hit == nil && budget != nil && *budget > 0 {
			*budget--
			hit, err = s.geo.Resolve(ctx, candidates, alpha2, true)
			if err != nil {
				return 0, 0, "", false, err
			}
		}
		if hit != nil {
			lat, lng = hit.Lat, hit.Lng
			name = hit.Name
			found = true
		}
		if !found && country != "" {
			if place, ok := dashboardwarmap.CountryCenter(country); ok {
				lat, lng, name = place.Lat, place.Lng, place.Name
				found = true
			}
		}
	}
	if !found || math.IsNaN(lat) || math.IsNaN(lng) || math.Abs(lat) > 90 || math.Abs(lng) > 180 {
		return 0, 0, "", false, nil
	}
	return lat, lng, name, true, nil
}

func geoTimestamp(row geoRow) (time.Time, bool) {
	if row.EventAt != nil {
		return row.EventAt.UTC(), true
	}
	if row.Processed != nil {
		return row.Processed.UTC(), true
	}
	return time.Time{}, false
}

func articleTimestamp(row geoRow) (time.Time, bool) {
	if row.EventAt != nil {
		return row.EventAt.UTC(), true
	}
	if row.CrawlAt != nil {
		return row.CrawlAt.UTC(), true
	}
	if row.Processed != nil {
		return row.Processed.UTC(), true
	}
	return time.Time{}, false
}

func (s *Service) Heatmap(ctx context.Context, orgID string, start, end time.Time, eventID string, includeBuckets bool) (heatResponse, error) {
	eventID = strings.TrimSpace(eventID)
	if s == nil || s.articles == nil {
		return heatResponse{}, errors.New("mysql is not configured")
	}
	rows, err := s.articles.Geo(ctx, orgID, start, end, eventID)
	if err != nil {
		return heatResponse{}, err
	}
	response := heatResponse{Points: []heatPointJSON{}}
	if len(rows) == 0 {
		return response, nil
	}
	sentiments := s.sentimentLabels(ctx, orgID, cleanedRefs(rows))
	halfLife := float64(heatHalfLifeDays) * float64(dayMS)
	nowMS := end.UnixMilli()
	type locationAgg struct {
		key        string
		candidates *candidateAgg
		heat       float64
		total      int
		sentiment  sentimentCounts
		buckets    map[string]*bucketJSON
		last       time.Time
		hasLast    bool
	}
	byKey := map[string]*locationAgg{}
	order := make([]string, 0)
	var updated time.Time
	hasUpdated := false
	for _, row := range rows {
		raw := stringsTrim(row.Location)
		if raw == "" {
			continue
		}
		key := normalizeLocationGroupKey(raw)
		if key == "" {
			continue
		}
		ts, ok := geoTimestamp(row)
		if !ok {
			continue
		}
		age := nowMS - ts.UnixMilli()
		if age < 0 {
			age = 0
		}
		weight := math.Exp(-float64(age) / halfLife)
		label := "unknown"
		if ref := stringsTrim(row.CleanedRef); ref != "" {
			if value, exists := sentiments[ref]; exists {
				label = value
			}
		}
		entry := byKey[key]
		if entry == nil {
			entry = &locationAgg{key: key, candidates: newCandidates(), buckets: map[string]*bucketJSON{}}
			byKey[key] = entry
			order = append(order, key)
		}
		entry.candidates.add(normalizeLocationCandidate(raw))
		entry.heat += weight
		entry.total++
		entry.sentiment.add(label)
		if !entry.hasLast || ts.After(entry.last) {
			entry.last = ts
			entry.hasLast = true
		}
		if includeBuckets {
			bucketStart := toISO(alignUTCDayStart(ts))
			bucket := entry.buckets[bucketStart]
			if bucket == nil {
				bucket = &bucketJSON{BucketStart: bucketStart}
				entry.buckets[bucketStart] = bucket
			}
			bucket.Total++
			bucket.Sentiment.add(label)
		}
		if !hasUpdated || ts.After(updated) {
			updated = ts
			hasUpdated = true
		}
	}
	if hasUpdated {
		response.UpdatedAt = toISO(updated)
	}
	locations := make([]*locationAgg, 0, len(order))
	for _, key := range order {
		locations = append(locations, byKey[key])
	}
	sort.SliceStable(locations, func(i, j int) bool {
		return locations[i].heat > locations[j].heat
	})
	if len(locations) > maxGeoLocations {
		locations = locations[:maxGeoLocations]
	}
	type cluster struct {
		id        string
		name      string
		lat       float64
		lng       float64
		heat      float64
		total     int
		sentiment sentimentCounts
		buckets   map[string]*bucketJSON
		keys      map[string]struct{}
	}
	clusters := map[string]*cluster{}
	clusterOrder := make([]string, 0)
	budget := maxGeoNetwork
	for _, loc := range locations {
		lat, lng, name, ok, locateErr := s.locate(ctx, loc.candidates.list(loc.key), &budget)
		if locateErr != nil {
			return heatResponse{}, locateErr
		}
		if !ok {
			continue
		}
		id, clusterLat, clusterLng := clusterKey(lat, lng)
		entry := clusters[id]
		if entry == nil {
			display := name
			if display == "" {
				display = loc.key
			}
			entry = &cluster{
				id: id, name: display, lat: clusterLat, lng: clusterLng,
				buckets: map[string]*bucketJSON{}, keys: map[string]struct{}{},
			}
			clusters[id] = entry
			clusterOrder = append(clusterOrder, id)
		}
		entry.keys[loc.key] = struct{}{}
		entry.heat += loc.heat
		entry.total += loc.total
		entry.sentiment.merge(loc.sentiment)
		if includeBuckets {
			for bucketStart, bucket := range loc.buckets {
				existing := entry.buckets[bucketStart]
				if existing == nil {
					copied := bucketJSON{BucketStart: bucketStart}
					existing = &copied
					entry.buckets[bucketStart] = existing
				}
				existing.Total += bucket.Total
				existing.Sentiment.merge(bucket.Sentiment)
			}
		}
	}
	sort.SliceStable(clusterOrder, func(i, j int) bool {
		return clusters[clusterOrder[i]].heat > clusters[clusterOrder[j]].heat
	})
	if len(clusterOrder) > maxGeoPoints {
		clusterOrder = clusterOrder[:maxGeoPoints]
	}
	pointKeys := map[string][]string{}
	for _, id := range clusterOrder {
		entry := clusters[id]
		point := heatPointJSON{
			ID: id, Name: entry.name, Lat: entry.lat, Lng: entry.lng,
			Heat: json.Number(heatNumber(entry.heat)), Total: entry.total, Sentiment: entry.sentiment,
		}
		if includeBuckets {
			buckets := make([]bucketJSON, 0, len(entry.buckets))
			names := make([]string, 0, len(entry.buckets))
			for name := range entry.buckets {
				names = append(names, name)
			}
			sort.SliceStable(names, func(i, j int) bool {
				return localeCompare(names[i], names[j]) < 0
			})
			for _, name := range names {
				buckets = append(buckets, *entry.buckets[name])
			}
			point.Buckets = &buckets
		}
		response.Points = append(response.Points, point)
		keys := make([]string, 0, len(entry.keys))
		for key := range entry.keys {
			keys = append(keys, key)
		}
		sort.SliceStable(keys, func(i, j int) bool {
			return localeCompare(keys[i], keys[j]) < 0
		})
		pointKeys[id] = keys
	}
	if body, snapshotID, ok := marshalSnapshot(orgID, eventID, start, end, pointKeys); ok && s.snaps != nil {
		if err := s.snaps.Save(ctx, orgID, snapshotID, body); err == nil {
			response.SnapshotID = snapshotID
		}
	}
	return response, nil
}

func (s *Service) HeatmapArticles(ctx context.Context, orgID string, start, end time.Time, eventID, snapshotID, pointID, bucketRaw string, limit int) (geoArticlesResponse, error) {
	eventID = strings.TrimSpace(eventID)
	snapshotID = strings.TrimSpace(snapshotID)
	pointID = stringsTrim(pointID)
	if pointID == "" {
		return geoArticlesResponse{}, errBad("pointId is required")
	}
	normalized, ok := normalizePointID(pointID)
	if !ok {
		return geoArticlesResponse{}, errBad("Invalid pointId")
	}
	response := geoArticlesResponse{PointID: normalized, Articles: []geoArticleJSON{}}
	queryStart, queryEnd := start, end
	if stringsTrim(bucketRaw) != "" {
		parsed, parsedOK := dashboardcharts.ParseJSDate(stringsTrim(bucketRaw))
		if !parsedOK {
			return geoArticlesResponse{}, errBad("Invalid bucketStart")
		}
		aligned := alignUTCDayStart(parsed)
		response.BucketStart = toISO(aligned)
		queryStart = aligned
		queryEnd = aligned.Add(time.Duration(dayMS) * time.Millisecond).Add(-time.Millisecond)
	}
	if s == nil || s.articles == nil {
		return geoArticlesResponse{}, errors.New("mysql is not configured")
	}
	rows, err := s.articles.Geo(ctx, orgID, queryStart, queryEnd, eventID)
	if err != nil {
		return geoArticlesResponse{}, err
	}
	if len(rows) == 0 {
		return response, nil
	}
	sorted := append([]geoRow(nil), rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		left, leftOK := articleTimestamp(sorted[i])
		right, rightOK := articleTimestamp(sorted[j])
		if !leftOK || !rightOK {
			return leftOK && !rightOK
		}
		return left.After(right)
	})
	if ts, tsOK := articleTimestamp(sorted[0]); tsOK {
		response.UpdatedAt = toISO(ts)
	}
	if snapshotID != "" {
		return s.articlesFromSnapshot(ctx, orgID, start, end, eventID, snapshotID, normalized, limit, sorted, response)
	}
	return s.articlesFromGeocode(ctx, orgID, normalized, limit, sorted, response)
}

func (s *Service) articlesFromSnapshot(ctx context.Context, orgID string, start, end time.Time, eventID, snapshotID, pointID string, limit int, rows []geoRow, response geoArticlesResponse) (geoArticlesResponse, error) {
	if s.snaps == nil {
		return geoArticlesResponse{}, errBad("Invalid snapshotId")
	}
	raw, ok, err := s.snaps.Load(ctx, orgID, snapshotID)
	if err != nil || !ok {
		return geoArticlesResponse{}, errBad("Invalid snapshotId")
	}
	view, parsed := parseSnapshot(raw, orgID)
	if !parsed {
		return geoArticlesResponse{}, errBad("Invalid snapshotId")
	}
	if view.eventID != eventID {
		return geoArticlesResponse{}, errBad("snapshotId does not match eventId")
	}
	if view.rangeStart != toISO(start) || view.rangeEnd != toISO(end) {
		return geoArticlesResponse{}, errBad("snapshotId does not match range")
	}
	allowed := map[string]struct{}{}
	for _, key := range view.keys[pointID] {
		allowed[key] = struct{}{}
	}
	if len(allowed) == 0 {
		return response, nil
	}
	return s.collectArticles(ctx, orgID, limit, rows, response, func(raw, groupKey string) (bool, error) {
		_, ok := allowed[groupKey]
		return ok, nil
	})
}

func (s *Service) articlesFromGeocode(ctx context.Context, orgID, pointID string, limit int, rows []geoRow, response geoArticlesResponse) (geoArticlesResponse, error) {
	candidates := map[string]*candidateAgg{}
	for _, row := range rows {
		raw := stringsTrim(row.Location)
		if raw == "" {
			continue
		}
		groupKey := normalizeLocationGroupKey(raw)
		if groupKey == "" {
			continue
		}
		agg := candidates[groupKey]
		if agg == nil {
			agg = newCandidates()
			candidates[groupKey] = agg
		}
		agg.add(normalizeLocationCandidate(raw))
	}
	resolved := map[string]string{}
	budget := maxGeoNetwork
	return s.collectArticles(ctx, orgID, limit, rows, response, func(raw, groupKey string) (bool, error) {
		if cached, ok := resolved[groupKey]; ok {
			return cached == pointID, nil
		}
		agg := candidates[groupKey]
		if agg == nil {
			resolved[groupKey] = ""
			return false, nil
		}
		lat, lng, _, ok, err := s.locate(ctx, agg.list(groupKey), &budget)
		if err != nil {
			return false, err
		}
		if !ok {
			resolved[groupKey] = ""
			return false, nil
		}
		key, _, _ := clusterKey(lat, lng)
		resolved[groupKey] = key
		return key == pointID, nil
	})
}

func (s *Service) collectArticles(ctx context.Context, orgID string, limit int, rows []geoRow, response geoArticlesResponse, match func(raw, groupKey string) (bool, error)) (geoArticlesResponse, error) {
	type picked struct {
		article geoArticleJSON
		ref     string
	}
	chosen := make([]picked, 0)
	for _, row := range rows {
		raw := stringsTrim(row.Location)
		if raw == "" {
			continue
		}
		groupKey := normalizeLocationGroupKey(raw)
		if groupKey == "" {
			continue
		}
		matched, err := match(raw, groupKey)
		if err != nil {
			return geoArticlesResponse{}, err
		}
		if !matched {
			continue
		}
		if len(chosen) >= limit {
			response.HasMore = true
			break
		}
		title := stringsTrim(row.Title)
		if title == "" {
			if row.URL != nil && *row.URL != "" {
				title = *row.URL
			} else {
				title = groupKey
			}
		}
		chosen = append(chosen, picked{
			ref: stringsTrim(row.CleanedRef),
			article: geoArticleJSON{
				ID: row.ID, Title: title, URL: row.URL, SourceLabel: row.SourceLabel, Location: raw,
				PublishedAt: isoPtr(row.Published), IngestedAt: isoPtr(row.CrawlAt), ProcessedAt: isoPtr(row.Processed),
			},
		})
	}
	refs := make([]string, 0, len(chosen))
	for _, item := range chosen {
		if item.ref != "" {
			refs = append(refs, item.ref)
		}
	}
	var labels map[string]string
	ok := false
	if s.items != nil {
		labels, ok = s.items.Sentiments(ctx, orgID, refs)
	}
	for _, item := range chosen {
		if ok && item.ref != "" {
			if label, exists := labels[item.ref]; exists {
				copied := label
				item.article.Sentiment = &copied
			}
		}
		response.Articles = append(response.Articles, item.article)
	}
	return response, nil
}

func (s *Service) sentimentLabels(ctx context.Context, orgID string, ids []string) map[string]string {
	if s.items == nil {
		return map[string]string{}
	}
	labels, ok := s.items.Sentiments(ctx, orgID, ids)
	if !ok || labels == nil {
		return map[string]string{}
	}
	return labels
}

func cleanedRefs(rows []geoRow) []string {
	refs := make([]string, 0, len(rows))
	for _, row := range rows {
		if ref := stringsTrim(row.CleanedRef); ref != "" {
			refs = append(refs, ref)
		}
	}
	return refs
}

func isoPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	text := toISO(value.UTC())
	return &text
}

func stringsTrim(value string) string {
	return strings.TrimSpace(value)
}
