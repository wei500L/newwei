package dashboardwarmap

import (
	"strings"
	"time"
)

type signal struct {
	name    string
	lat     float64
	lng     float64
	alerts  int
	score   float64
	maxRank int
	news    int
	latest  *time.Time
	saved   bool
}

func assembleEvents(alerts []alertRow, articles []articlePoint, mongo []mongoRow, geo *geoIndex) (eventsResponse, []string) {
	signals := map[string]*signal{}
	order := make([]string, 0)
	ensure := func(code string, point geoPoint) *signal {
		if existing := signals[code]; existing != nil {
			return existing
		}
		return &signal{name: point.Name, lat: point.Lat, lng: point.Lng}
	}
	save := func(code string, entry *signal) {
		if entry.saved {
			return
		}
		entry.saved = true
		signals[code] = entry
		order = append(order, code)
	}

	for _, event := range alerts {
		for _, code := range countryCodesFromContext(event.Context) {
			point, ok := geo.get(code)
			if !ok {
				continue
			}
			entry := ensure(code, point)
			rank := severityRank(event.Severity)
			if rank == 0 {
				rank = 1
			}
			entry.score += float64(rank)
			entry.alerts++
			if rank > entry.maxRank {
				entry.maxRank = rank
			}
			entry.latest = later(entry.latest, event.TriggeredAt)
			save(code, entry)
		}
	}

	for _, record := range articles {
		location := strings.TrimSpace(record.Location)
		if location == "" {
			continue
		}
		code := normalizeCountryCode(extractCountryCodeFromText(location))
		if code == "" {
			code = normalizeCountryCode(location)
		}
		if code == "" {
			continue
		}
		point, ok := geo.get(code)
		if !ok {
			continue
		}
		existing := signals[code]
		entry := ensure(code, point)
		entry.news++
		latest := record.EventAt
		if latest == nil {
			latest = record.ProcessedAt
		}
		if latest == nil {
			if existing != nil {
				existing.news = entry.news
			}
			continue
		}
		entry.latest = later(entry.latest, *latest)
		save(code, entry)
	}

	for _, record := range mongo {
		location := strings.TrimSpace(record.Location)
		if location == "" {
			continue
		}
		code := resolveCountry(location, normalizeEntities(record.Entities))
		if code == "" {
			continue
		}
		point, ok := geo.get(code)
		if !ok {
			continue
		}
		latest := firstTime(record.PublishedAt, record.SortAt, record.IngestedAt, record.CreatedAt)
		if latest == nil {
			continue
		}
		entry := ensure(code, point)
		entry.news++
		entry.latest = later(entry.latest, *latest)
		save(code, entry)
	}

	events := make([]warEvent, 0, len(order))
	var updated *time.Time
	names := make([]string, 0, len(order))
	for _, code := range order {
		entry := signals[code]
		if entry == nil || entry.latest == nil {
			continue
		}
		alertScore := jsFixed2(entry.score)
		derived := alertScore + float64(entry.news)
		if derived < 1 {
			derived = 1
		}
		newsRank := 0
		switch {
		case entry.news >= 8:
			newsRank = 3
		case entry.news >= 4:
			newsRank = 2
		case entry.news > 0:
			newsRank = 1
		}
		rank := entry.maxRank
		if newsRank > rank {
			rank = newsRank
		}
		severity := "low"
		if rank > 0 {
			severity = severityByRank(rank)
		}
		events = append(events, warEvent{
			ID:           strings.ToLower(code),
			Name:         entry.name,
			Lat:          entry.lat,
			Lng:          entry.lng,
			Severity:     severity,
			LatestAt:     iso(*entry.latest),
			DerivedScore: derived,
			Value:        derived,
			AlertScore:   alertScore,
			AlertCount:   entry.alerts,
			NewsCount:    entry.news,
		})
		names = append(names, entry.name)
		updated = later(updated, *entry.latest)
	}
	body := eventsResponse{Events: events, Clustered: false}
	if updated != nil {
		body.UpdatedAt = iso(*updated)
	}
	return body, names
}

func countryCodesFromContext(context map[string]any) []string {
	if context == nil {
		return nil
	}
	seen := map[string]struct{}{}
	var codes []string
	add := func(value any) {
		text, ok := value.(string)
		if !ok {
			return
		}
		code := normalizeCountryCode(text)
		if code == "" {
			code = extractCountryCodeFromText(text)
		}
		if code == "" {
			return
		}
		if _, ok := seen[code]; ok {
			return
		}
		seen[code] = struct{}{}
		codes = append(codes, code)
	}
	add(context["countryCode"])
	add(context["countryName"])
	add(context["country"])
	addList(context["countryCodes"], add)
	hotspots, _ := context["hotspots"].([]any)
	for _, hotspot := range hotspots {
		record, ok := hotspot.(map[string]any)
		if !ok {
			continue
		}
		add(record["countryCode"])
		add(record["countryName"])
		add(record["country"])
		addList(record["countryCodes"], add)
	}
	return codes
}

func addList(value any, add func(any)) {
	list, ok := value.([]any)
	if !ok {
		return
	}
	for _, entry := range list {
		add(entry)
	}
}

func normalizeEntities(input any) []cleanedEntity {
	list, ok := input.([]any)
	if !ok {
		return nil
	}
	var entities []cleanedEntity
	for _, entry := range list {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, _ := record["name"].(string)
		kind, _ := record["type"].(string)
		name = strings.TrimSpace(name)
		kind = strings.TrimSpace(kind)
		if name == "" || kind == "" {
			continue
		}
		confidence := 0.0
		switch n := record["confidence"].(type) {
		case float64:
			if !isBad(n) {
				confidence = n
			}
		}
		entities = append(entities, cleanedEntity{Name: name, Type: kind, Confidence: confidence})
	}
	return entities
}

func isBad(n float64) bool {
	return n != n || n > 1e308 || n < -1e308
}

func resolveCountry(location string, entities []cleanedEntity) string {
	if code := extractCountryCodeFromText(location); code != "" {
		return code
	}
	if code := normalizeCountryCode(location); code != "" {
		return code
	}
	for _, entity := range entities {
		if code := normalizeCountryCode(entity.Name); code != "" {
			return code
		}
		if code := extractCountryCodeFromText(entity.Name); code != "" {
			return code
		}
	}
	return ""
}

func locationEntity(kind string) bool {
	normalized := strings.ToLower(strings.TrimSpace(kind))
	switch {
	case normalized == "location":
		return true
	case strings.Contains(normalized, "loc"),
		strings.Contains(normalized, "place"),
		strings.Contains(normalized, "geo"),
		strings.Contains(normalized, "city"),
		strings.Contains(normalized, "country"),
		strings.Contains(normalized, "region"),
		strings.Contains(normalized, "state"),
		strings.Contains(normalized, "province"),
		strings.Contains(normalized, "地点"),
		strings.Contains(normalized, "地點"),
		strings.Contains(normalized, "地区"),
		strings.Contains(normalized, "地區"),
		strings.Contains(normalized, "城市"),
		strings.Contains(normalized, "国家"),
		strings.Contains(normalized, "國家"):
		return true
	default:
		return false
	}
}

func geocodeCandidates(location string, entities []cleanedEntity, country string) []string {
	var candidates []string
	push := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		candidates = append(candidates, value)
	}
	selected := make([]cleanedEntity, 0)
	for _, entity := range entities {
		if entity.Confidence >= 0.5 && locationEntity(entity.Type) {
			selected = append(selected, entity)
		}
	}
	for i := 1; i < len(selected); i++ {
		item := selected[i]
		j := i
		for j > 0 && selected[j-1].Confidence < item.Confidence {
			selected[j] = selected[j-1]
			j--
		}
		selected[j] = item
	}
	if len(selected) > 3 {
		selected = selected[:3]
	}
	for _, entity := range selected {
		if country != "" && !strings.Contains(strings.ToLower(entity.Name), strings.ToLower(country)) {
			push(entity.Name + ", " + country)
		}
		push(entity.Name)
	}
	parts := strings.FieldsFunc(location, func(r rune) bool {
		switch r {
		case ',', '，', ';', '；', '/', '|':
			return true
		default:
			return false
		}
	})
	primary := ""
	if len(parts) > 0 {
		primary = strings.TrimSpace(parts[0])
	}
	if primary != "" && primary != location {
		if country != "" && !strings.Contains(strings.ToLower(primary), strings.ToLower(country)) {
			push(primary + ", " + country)
		}
		push(primary)
	}
	if country != "" && !strings.Contains(strings.ToLower(location), strings.ToLower(country)) {
		push(location + ", " + country)
	}
	push(location)
	if country != "" {
		push(country)
	}
	return candidates
}

func firstTime(values ...*time.Time) *time.Time {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func applyEventTranslations(events []warEvent, translated map[string]string) {
	if len(translated) == 0 {
		return
	}
	for i := range events {
		if name := translated[events[i].Name]; name != "" {
			events[i].NameZh = name
		}
	}
}

func applyMarkerTranslations(markers []newsMarker, translated map[string]string) {
	if len(translated) == 0 {
		return
	}
	for i := range markers {
		if value := translated[markers[i].Title]; value != "" {
			markers[i].TitleZh = value
		}
		if value := translated[markers[i].Location]; value != "" {
			markers[i].LocationZh = value
		}
		if markers[i].DisplayName != "" {
			if value := translated[markers[i].DisplayName]; value != "" {
				markers[i].DisplayNameZh = value
			}
		}
	}
}

func uniqTexts(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
