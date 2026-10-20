package realtimesignals

import (
	"context"
	"log"
	"math"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

// Unrest, outages, PizzINT and GDELT tension. All four are global responses and
// are fetched once per round by the shared source context; failures are shared
// too, so every organization records the same error.

// UnrestEvent is UnrestEventCandidate.
type UnrestEvent struct {
	ID          string
	Lat         float64
	Lon         float64
	OccurredAt  string
	Source      string
	CountryCode string
	Reports     float64
}

// UnrestFeedResult is UnrestFeedFetchResult. HasError distinguishes an included
// `error` member from an absent one, which the feedErrors context depends on.
type UnrestFeedResult struct {
	Events     []UnrestEvent
	Configured bool
	Error      string
	HasError   bool
}

// fetchUnrestSignal mirrors fetchUnrestSignal.
func (s *Service) fetchUnrestSignal(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) ([]FetchResult, error) {
	type acledOutcome struct{ feed UnrestFeedResult }
	type gdeltOutcome struct{ feed UnrestFeedResult }
	acledChannel := make(chan acledOutcome, 1)
	gdeltChannel := make(chan gdeltOutcome, 1)
	go func() {
		if !runtime.Capabilities.AcledAPIEnabled {
			acledChannel <- acledOutcome{feed: UnrestFeedResult{Events: []UnrestEvent{}, Configured: false}}
			return
		}
		acledChannel <- acledOutcome{feed: s.fetchAcledUnrestEvents(ctx, runtime)}
	}()
	go func() {
		gdeltChannel <- gdeltOutcome{feed: s.fetchGdeltUnrestEvents(ctx, runtime)}
	}()
	acledFeed := (<-acledChannel).feed
	gdeltFeed := (<-gdeltChannel).feed

	merged := mergeUnrestEvents(acledFeed.Events, gdeltFeed.Events)
	countries := make([]string, 0, len(merged))
	for _, entry := range merged {
		if entry.CountryCode != "" {
			countries = append(countries, entry.CountryCode)
		}
	}
	countries = dedupeStringsPreserve(countries)
	source := "none"
	switch {
	case len(acledFeed.Events) > 0 && len(gdeltFeed.Events) > 0:
		source = "acled+gdelt"
	case len(acledFeed.Events) > 0:
		source = "acled"
	case len(gdeltFeed.Events) > 0:
		source = "gdelt"
	}
	feedErrors := unrestFeedErrors{}
	if runtime.Capabilities.AcledAPIEnabled && acledFeed.HasError {
		value := acledFeed.Error
		feedErrors.ACLED = &value
	}
	if gdeltFeed.HasError {
		value := gdeltFeed.Error
		feedErrors.GDELT = &value
	}
	unrestMode := "gdelt_only"
	if runtime.Capabilities.AcledAPIEnabled {
		unrestMode = "acled_gdelt"
	}
	return []FetchResult{{
		MetricSlug: metricUnrest,
		Value:      float64(len(merged)),
		Context: &unrestContext{
			Source:                 source,
			UnrestCount:            float64(len(merged)),
			ACLEDCount:             float64(len(acledFeed.Events)),
			GDELTCount:             float64(len(gdeltFeed.Events)),
			DedupeReducedBy:        float64(len(acledFeed.Events) + len(gdeltFeed.Events) - len(merged)),
			ACLEDConfigured:        acledFeed.Configured,
			ACLEDAPIEnabled:        runtime.Capabilities.AcledAPIEnabled,
			ACLEDAPIDisabledReason: runtime.Capabilities.AcledAPIDisabledReason,
			UnrestMode:             unrestMode,
			CountryCodes:           countries,
			FeedErrors:             feedErrors,
		},
	}}, nil
}

// fetchAcledUnrestEvents mirrors fetchAcledUnrestEvents, including the single
// 401/403 token refresh and retry.
func (s *Service) fetchAcledUnrestEvents(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) UnrestFeedResult {
	if !runtime.Capabilities.AcledAPIEnabled {
		return UnrestFeedResult{Events: []UnrestEvent{}, Configured: false}
	}
	now := s.clockMillis()
	startDate := strings.Split(formatISO(now-30*24*60*60*1000), "T")[0]
	endDate := strings.Split(formatISO(now), "T")[0]
	target := s.endpoints.acledURL() + "?" + encodeFormPairs(
		[2]string{"event_type", "Protests"},
		[2]string{"event_date", startDate + "|" + endDate},
		[2]string{"event_date_where", "BETWEEN"},
		[2]string{"limit", "500"},
		[2]string{"_format", "json"},
	)
	fetchRows := func(token string) ([]UnrestEvent, error) {
		payload, err := s.http.fetchJSON(ctx, runtime, target, fetchOptions{
			Headers: map[string]string{"Authorization": "Bearer " + token},
		})
		if err != nil {
			return nil, err
		}
		return s.readACLEDUnrestRows(payload), nil
	}
	token := jsTrim(runtime.Credentials.AcledAccessToken)
	if token == "" {
		return UnrestFeedResult{
			Events: []UnrestEvent{}, Configured: false,
			Error: "ACLED access token is not configured.", HasError: true,
		}
	}
	events, err := fetchRows(token)
	if err == nil {
		return UnrestFeedResult{Events: events, Configured: true}
	}
	if status := readHTTPStatus(err); status != nil && (*status == 401 || *status == 403) {
		refreshedToken, refreshErr := s.runtime.ForceRefreshAcledAccessToken(ctx)
		if refreshErr != nil {
			log.Printf("realtimesignals: ACLED token refresh failed after unauthorized response: %v", refreshErr)
		} else if jsTrim(refreshedToken) != "" {
			retriedEvents, retryErr := fetchRows(jsTrim(refreshedToken))
			if retryErr == nil {
				return UnrestFeedResult{Events: retriedEvents, Configured: true}
			}
			log.Printf("realtimesignals: ACLED unrest request failed after token refresh: %v", retryErr)
			return UnrestFeedResult{
				Events: []UnrestEvent{}, Configured: true,
				Error: diagnosticErrorMessage(retryErr, readHTTPStatus(retryErr)), HasError: true,
			}
		}
	}
	log.Printf("realtimesignals: ACLED unrest request failed: %v", err)
	return UnrestFeedResult{
		Events: []UnrestEvent{}, Configured: true,
		Error: diagnosticErrorMessage(err, readHTTPStatus(err)), HasError: true,
	}
}

// acledRowPayload is one ACLED data[] row.
type acledRowPayload struct {
	Latitude    jsonRawMessage `json:"latitude"`
	Longitude   jsonRawMessage `json:"longitude"`
	EventDate   jsonRawMessage `json:"event_date"`
	OccurredAt  jsonRawMessage `json:"occurredAt"`
	EventID     jsonRawMessage `json:"event_id_cnty"`
	ISO         jsonRawMessage `json:"iso"`
	CountryCode jsonRawMessage `json:"country_code"`
	Country     jsonRawMessage `json:"country"`
	Admin1      jsonRawMessage `json:"admin1"`
	Location    jsonRawMessage `json:"location"`
	Fatalities  jsonRawMessage `json:"fatalities"`
}

// readACLEDUnrestRows mirrors readAcledUnrestRows.
func (s *Service) readACLEDUnrestRows(payload jsonRawMessage) []UnrestEvent {
	var response struct {
		Data    jsonRawMessage `json:"data"`
		Message jsonRawMessage `json:"message"`
		Error   jsonRawMessage `json:"error"`
	}
	_ = decodeJSONPayload(payload, &response)
	if normalizeStringRaw(response.Message) != "" || normalizeStringRaw(response.Error) != "" {
		log.Printf("realtimesignals: ACLED unrest request returned error payload message=%s error=%s",
			normalizeStringRaw(response.Message), normalizeStringRaw(response.Error))
		return []UnrestEvent{}
	}
	events := readArray(response.Data)
	rows := make([]UnrestEvent, 0, len(events))
	for index, entry := range events {
		var row acledRowPayload
		if !isJSONObject(entry) || decodeJSONPayload(entry, &row) != nil {
			continue
		}
		lat, latOK := toFiniteNumber(row.Latitude)
		lon, lonOK := toFiniteNumber(row.Longitude)
		if !latOK || !lonOK || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		occurredAt := toIsoTimestamp(firstRaw(row.EventDate, row.OccurredAt))
		eventID := normalizeStringRaw(row.EventID)
		if eventID == "" {
			eventID = "acled-" + jsToFixed(lat, 3) + "-" + jsToFixed(lon, 3) + "-" + toDateBucket(occurredAt) + "-" + jsNumberString(float64(index))
		}
		reports := math.Max(1, float64(jsTrunc(finiteOr(row.Fatalities, 1))))
		rows = append(rows, UnrestEvent{
			ID:          "acled-" + eventID,
			Lat:         lat,
			Lon:         lon,
			OccurredAt:  occurredAt,
			Source:      "acled",
			CountryCode: extractCountryCode(firstRawString(row.ISO, row.CountryCode, row.Country, row.Admin1, row.Location)),
			Reports:     reports,
		})
	}
	return rows
}

// gdeltFeaturePayload is one GKG feature.
type gdeltFeaturePayload struct {
	Properties jsonRawMessage `json:"properties"`
	Geometry   jsonRawMessage `json:"geometry"`
}

type gdeltPropertiesPayload struct {
	Name            jsonRawMessage `json:"name"`
	Location        jsonRawMessage `json:"location"`
	Title           jsonRawMessage `json:"title"`
	MentionedThemes jsonRawMessage `json:"mentionedthemes"`
	Themes          jsonRawMessage `json:"themes"`
	URLTone         jsonRawMessage `json:"urltone"`
	Tone            jsonRawMessage `json:"tone"`
	ToneAvg         jsonRawMessage `json:"toneavg"`
	URLPubTimeDate  jsonRawMessage `json:"urlpubtimedate"`
	Date            jsonRawMessage `json:"date"`
	EventDate       jsonRawMessage `json:"event_date"`
	Timestamp       jsonRawMessage `json:"timestamp"`
	DateTime        jsonRawMessage `json:"datetime"`
}

type gdeltGeometryPayload struct {
	Coordinates jsonRawMessage `json:"coordinates"`
}

// fetchGdeltUnrestEvents mirrors fetchGdeltUnrestEvents.
func (s *Service) fetchGdeltUnrestEvents(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) UnrestFeedResult {
	target := s.endpoints.gdeltUnrestURL() + "?" + encodeFormPairs(
		[2]string{"QUERY", "PROTEST"},
		[2]string{"TIMESPAN", "10080"},
		[2]string{"MAXROWS", "250"},
		[2]string{"OUTPUTFIELDS", "name,url,urlpubtimedate,urltone,mentionedthemes,geores"},
	)
	payload, err := s.http.fetchJSON(ctx, runtime, target, fetchOptions{})
	if err != nil {
		log.Printf("realtimesignals: GDELT unrest request failed: %v", err)
		return UnrestFeedResult{
			Events: []UnrestEvent{}, Configured: true,
			Error: diagnosticErrorMessage(err, readHTTPStatus(err)), HasError: true,
		}
	}
	var document struct {
		Features jsonRawMessage `json:"features"`
	}
	_ = decodeJSONPayload(payload, &document)
	features := readArray(document.Features)

	order := make([]string, 0, len(features))
	grouped := make(map[string]*UnrestEvent, len(features))
	for index, feature := range features {
		var item gdeltFeaturePayload
		if !isJSONObject(feature) || decodeJSONPayload(feature, &item) != nil {
			continue
		}
		var properties gdeltPropertiesPayload
		if isJSONObject(item.Properties) {
			_ = decodeJSONPayload(item.Properties, &properties)
		}
		var geometry gdeltGeometryPayload
		if isJSONObject(item.Geometry) {
			_ = decodeJSONPayload(item.Geometry, &geometry)
		}
		name := normalizeStringRaw(firstRaw(properties.Name, properties.Location, properties.Title))
		if name == "" {
			continue
		}
		mentionedThemes := normalizeStringRaw(firstRaw(properties.MentionedThemes, properties.Themes))
		if mentionedThemes != "" && !strings.Contains(strings.ToLower(mentionedThemes), "protest") {
			continue
		}
		if tone, ok := toFiniteNumber(firstRaw(properties.URLTone, properties.Tone, properties.ToneAvg)); ok && tone > 0.25 {
			continue
		}
		coordinates := readArray(geometry.Coordinates)
		if len(coordinates) < 2 {
			continue
		}
		lon, lonOK := toFiniteNumber(coordinates[0])
		lat, latOK := toFiniteNumber(coordinates[1])
		if !latOK || !lonOK || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		occurredAt := toIsoTimestamp(firstRaw(properties.URLPubTimeDate, properties.Date, properties.EventDate,
			properties.Timestamp, properties.DateTime, jsonRawMessage(jsNumberString(float64(s.clockMillis())))))
		countryRaw := name
		if parts := strings.Split(name, ","); len(parts) > 0 {
			countryRaw = jsTrim(parts[len(parts)-1])
		}
		aggregateKey := strings.ToLower(name) + ":" + toDateBucket(occurredAt)
		existing, exists := grouped[aggregateKey]
		if !exists {
			event := &UnrestEvent{
				ID:          "gdelt-" + jsToFixed(lat, 2) + "-" + jsToFixed(lon, 2) + "-" + toDateBucket(occurredAt) + "-" + jsNumberString(float64(index)),
				Lat:         lat,
				Lon:         lon,
				OccurredAt:  occurredAt,
				Source:      "gdelt",
				CountryCode: extractCountryCode(countryRaw),
				Reports:     1,
			}
			order = append(order, aggregateKey)
			grouped[aggregateKey] = event
			continue
		}
		existing.Reports++
		existingMs, existingOK := parseJSTimeMillis(existing.OccurredAt)
		candidateMs, candidateOK := parseJSTimeMillis(occurredAt)
		if candidateOK && (!existingOK || candidateMs > existingMs) {
			existing.OccurredAt = occurredAt
			existing.ID = "gdelt-" + jsToFixed(lat, 2) + "-" + jsToFixed(lon, 2) + "-" + toDateBucket(occurredAt) + "-" + jsNumberString(float64(index))
		}
		if existing.CountryCode == "" {
			existing.CountryCode = extractCountryCode(countryRaw)
		}
	}
	rows := make([]UnrestEvent, 0, len(order))
	for _, key := range order {
		if grouped[key].Reports >= 2 {
			rows = append(rows, *grouped[key])
		}
	}
	sort.SliceStable(rows, func(left, right int) bool {
		if rows[right].Reports != rows[left].Reports {
			return rows[right].Reports < rows[left].Reports
		}
		leftMs, _ := parseJSTimeMillis(rows[left].OccurredAt)
		rightMs, _ := parseJSTimeMillis(rows[right].OccurredAt)
		return rightMs < leftMs
	})
	return UnrestFeedResult{Events: rows, Configured: true}
}

// mergeUnrestEvents mirrors mergeUnrestEvents.
func mergeUnrestEvents(acledEvents, gdeltEvents []UnrestEvent) []UnrestEvent {
	order := make([]string, 0, len(acledEvents)+len(gdeltEvents))
	unique := make(map[string]*UnrestEvent, len(acledEvents)+len(gdeltEvents))
	all := make([]UnrestEvent, 0, len(acledEvents)+len(gdeltEvents))
	all = append(all, acledEvents...)
	all = append(all, gdeltEvents...)
	for _, event := range all {
		key := buildUnrestMergeKey(event)
		existing, exists := unique[key]
		if !exists {
			copied := event
			order = append(order, key)
			unique[key] = &copied
			continue
		}
		if event.Source == "acled" && existing.Source != "acled" {
			copied := event
			copied.Reports = math.Max(event.Reports, existing.Reports)
			if event.CountryCode != "" {
				copied.CountryCode = event.CountryCode
			} else {
				copied.CountryCode = existing.CountryCode
			}
			unique[key] = &copied
			continue
		}
		if existing.Source == "acled" {
			existing.Reports = math.Max(existing.Reports, event.Reports)
			if existing.CountryCode == "" && event.CountryCode != "" {
				existing.CountryCode = event.CountryCode
			}
			continue
		}
		existing.Reports = math.Max(existing.Reports, event.Reports)
		if existing.CountryCode == "" && event.CountryCode != "" {
			existing.CountryCode = event.CountryCode
		}
		existingMs, existingOK := parseJSTimeMillis(existing.OccurredAt)
		candidateMs, candidateOK := parseJSTimeMillis(event.OccurredAt)
		if candidateOK && (!existingOK || candidateMs > existingMs) {
			existing.ID = event.ID
			existing.OccurredAt = event.OccurredAt
		}
	}
	rows := make([]UnrestEvent, 0, len(order))
	for _, key := range order {
		rows = append(rows, *unique[key])
	}
	sort.SliceStable(rows, func(left, right int) bool {
		leftMs, leftOK := parseJSTimeMillis(rows[left].OccurredAt)
		rightMs, rightOK := parseJSTimeMillis(rows[right].OccurredAt)
		if leftOK && rightOK {
			return rightMs < leftMs
		}
		if rightOK {
			return true
		}
		if leftOK {
			return false
		}
		return false
	})
	return rows
}

// buildUnrestMergeKey mirrors buildUnrestMergeKey: Math.round(lat * 10) / 10.
func buildUnrestMergeKey(event UnrestEvent) string {
	latKey := jsRound(event.Lat*10) / 10
	lonKey := jsRound(event.Lon*10) / 10
	return jsNumberString(latKey) + ":" + jsNumberString(lonKey) + ":" + toDateBucket(event.OccurredAt)
}

// fetchOutagesSignal mirrors fetchOutagesSignal.
func (s *Service) fetchOutagesSignal(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) ([]FetchResult, error) {
	token := jsTrim(runtime.Credentials.CloudflareAPIToken)
	if token == "" {
		return []FetchResult{{
			MetricSlug: metricOutages,
			Value:      0,
			Context:    &outagesNotConfiguredContext{Configured: false, Source: "cloudflare"},
		}}, nil
	}
	payload, err := s.http.fetchJSON(ctx, runtime, s.endpoints.cloudflareURL(), fetchOptions{
		Headers: map[string]string{"Authorization": "Bearer " + token},
	})
	if err != nil {
		return nil, err
	}
	var response struct {
		Result jsonRawMessage `json:"result"`
	}
	_ = decodeJSONPayload(payload, &response)
	result := readArray(response.Result)
	countries := make([]string, 0)
	for _, outage := range result {
		var record struct {
			Locations jsonRawMessage `json:"locations"`
		}
		if !isJSONObject(outage) || decodeJSONPayload(outage, &record) != nil {
			continue
		}
		for _, location := range readArray(record.Locations) {
			var entry struct {
				Alpha2      jsonRawMessage `json:"alpha2"`
				CountryCode jsonRawMessage `json:"countryCode"`
				Name        jsonRawMessage `json:"name"`
			}
			if !isJSONObject(location) || decodeJSONPayload(location, &entry) != nil {
				continue
			}
			if code := extractCountryCode(firstRawString(entry.Alpha2, entry.CountryCode, entry.Name)); code != "" {
				countries = append(countries, code)
			}
		}
	}
	return []FetchResult{{
		MetricSlug: metricOutages,
		Value:      float64(len(result)),
		Context: &outagesContext{
			Source:       "cloudflare",
			Outages:      float64(len(result)),
			CountryCodes: dedupeStringsPreserve(countries),
		},
	}}, nil
}

// pizzintPayload is the dashboard response.
type pizzintPayload struct {
	Locations jsonRawMessage `json:"locations"`
	Data      struct {
		Locations jsonRawMessage `json:"locations"`
	} `json:"data"`
}

type pizzintLocationPayload struct {
	Open        jsonRawMessage `json:"open"`
	IsOpen      jsonRawMessage `json:"is_open"`
	Status      jsonRawMessage `json:"status"`
	ActiveSpike jsonRawMessage `json:"activeSpike"`
	HasSpike    jsonRawMessage `json:"has_spike"`
	Spike       jsonRawMessage `json:"spike"`
	Pop         jsonRawMessage `json:"pop"`
	AvgPop      jsonRawMessage `json:"avg_pop"`
	Traffic     jsonRawMessage `json:"traffic"`
}

// fetchPizzintSignal mirrors fetchPizzintSignal.
func (s *Service) fetchPizzintSignal(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) ([]FetchResult, error) {
	payload, err := s.http.fetchJSON(ctx, runtime, s.endpoints.pizzintDashboardURL(), fetchOptions{})
	if err != nil {
		return nil, err
	}
	var body pizzintPayload
	_ = decodeJSONPayload(payload, &body)
	locationsRaw := body.Locations
	if rawIsAbsent(locationsRaw) {
		locationsRaw = body.Data.Locations
	}
	locations := readArray(locationsRaw)
	openCount := 0
	activeSpikes := 0
	popSum := 0.0
	for _, entry := range locations {
		var record pizzintLocationPayload
		if !isJSONObject(entry) || decodeJSONPayload(entry, &record) != nil {
			continue
		}
		isOpen := rawBool(record.Open) || rawBool(record.IsOpen) || rawStringExact(record.Status) == "open"
		if isOpen {
			openCount++
			switch {
			case isNumberValue(record.Pop):
				value, _ := toFiniteNumber(record.Pop)
				popSum += value
			case isNumberValue(record.AvgPop):
				value, _ := toFiniteNumber(record.AvgPop)
				popSum += value
			case isNumberValue(record.Traffic):
				value, _ := toFiniteNumber(record.Traffic)
				popSum += value
			}
		}
		if rawBool(record.ActiveSpike) || rawBool(record.HasSpike) || rawBool(record.Spike) {
			activeSpikes++
		}
	}
	avgPop := 0.0
	if openCount > 0 {
		avgPop = popSum / float64(openCount)
	}
	adjustedScore := math.Min(100, avgPop+float64(activeSpikes)*10)
	defcon := 5.0
	switch {
	case adjustedScore >= 85:
		defcon = 1
	case adjustedScore >= 70:
		defcon = 2
	case adjustedScore >= 50:
		defcon = 3
	case adjustedScore >= 25:
		defcon = 4
	}
	return []FetchResult{{
		MetricSlug: metricPizzint,
		Value:      defcon,
		Context: &pizzintContext{
			Source:        "pizzint",
			Defcon:        defcon,
			AdjustedScore: jsFixedNumber(adjustedScore, 3),
			OpenLocations: float64(openCount),
			ActiveSpikes:  float64(activeSpikes),
			AvgPop:        jsFixedNumber(avgPop, 3),
		},
	}}, nil
}

// gdeltTensionPayload is the batch response. The container either is the payload
// itself or payload.data; the pair members are fixed, so each gets a named field.
type gdeltTensionPayload struct {
	USARussia     jsonRawMessage `json:"usa_russia"`
	RussiaUkraine jsonRawMessage `json:"russia_ukraine"`
	USAChina      jsonRawMessage `json:"usa_china"`
	ChinaTaiwan   jsonRawMessage `json:"china_taiwan"`
	USAIran       jsonRawMessage `json:"usa_iran"`
	USAVenezuela  jsonRawMessage `json:"usa_venezuela"`
	Data          jsonRawMessage `json:"data"`
}

type tensionPointPayload struct {
	V         jsonRawMessage `json:"v"`
	Value     jsonRawMessage `json:"value"`
	Score     jsonRawMessage `json:"score"`
	T         jsonRawMessage `json:"t"`
	Timestamp jsonRawMessage `json:"timestamp"`
	Date      jsonRawMessage `json:"date"`
}

// fetchGdeltTensionSignal mirrors fetchGdeltTensionSignal.
func (s *Service) fetchGdeltTensionSignal(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) ([]FetchResult, error) {
	now := s.clockMillis()
	startDate := toCompactDayString(now - 7*24*60*60*1000)
	endDate := toCompactDayString(now)
	target := s.endpoints.pizzintTensionURL() + "?" + encodeFormPairs(
		[2]string{"pairs", strings.Join(gdeltTensionPairs, ",")},
		[2]string{"method", "gpr"},
		[2]string{"dateStart", startDate},
		[2]string{"dateEnd", endDate},
	)
	payload, err := s.http.fetchJSON(ctx, runtime, target, fetchOptions{})
	if err != nil {
		return nil, err
	}
	tensions := parseTensionPayload(payload)
	if len(tensions) == 0 {
		return []FetchResult{{
			MetricSlug: metricGdeltTension,
			Value:      0,
			Context: &gdeltTensionContext{
				Source: "pizzint-gdelt", Tensions: []TensionRow{}, CountryCodes: []string{},
				DateStart: startDate, DateEnd: endDate,
			},
		}}, nil
	}
	maxScore := 0.0
	for _, item := range tensions {
		maxScore = math.Max(maxScore, item.Score)
	}
	countryCodes := make([]string, 0)
	for _, item := range tensions {
		countryCodes = append(countryCodes, item.Countries...)
	}
	return []FetchResult{{
		MetricSlug: metricGdeltTension,
		Value:      jsFixedNumber(maxScore, 3),
		Context: &gdeltTensionContext{
			Source:       "pizzint-gdelt",
			Tensions:     tensions,
			CountryCodes: dedupeStringsPreserve(countryCodes),
			DateStart:    startDate,
			DateEnd:      endDate,
		},
	}}, nil
}

// parseTensionPayload mirrors parseTensionPayload.
func parseTensionPayload(payload jsonRawMessage) []TensionRow {
	rows := make([]TensionRow, 0)
	if !isJSONObject(payload) {
		return rows
	}
	var body gdeltTensionPayload
	if decodeJSONPayload(payload, &body) != nil {
		return rows
	}
	// The container is payload.data when that member is an object, otherwise the
	// payload itself. Both shapes expose the same pair members.
	container := payload
	if isJSONObject(body.Data) {
		container = body.Data
	}
	var containerBody gdeltTensionPayload
	_ = decodeJSONPayload(container, &containerBody)
	seriesByPair := []jsonRawMessage{
		containerBody.USARussia, containerBody.RussiaUkraine, containerBody.USAChina,
		containerBody.ChinaTaiwan, containerBody.USAIran, containerBody.USAVenezuela,
	}
	for index, pair := range gdeltTensionPairs {
		series := readArray(seriesByPair[index])
		if len(series) == 0 {
			continue
		}
		points := make([]struct {
			value float64
			ts    string
		}, 0, len(series))
		for _, entry := range series {
			var point tensionPointPayload
			if !isJSONObject(entry) || decodeJSONPayload(entry, &point) != nil {
				continue
			}
			value, ok := toFiniteNumber(firstRaw(point.V, point.Value, point.Score))
			if !ok {
				continue
			}
			ts := normalizeStringRaw(firstRaw(point.T, point.Timestamp, point.Date))
			if ts == "" {
				ts = formatISO(s.clockMillis())
			}
			points = append(points, struct {
				value float64
				ts    string
			}{value: value, ts: ts})
		}
		if len(points) == 0 {
			continue
		}
		latest := points[len(points)-1]
		changePercent := 0.0
		if len(points) > 1 {
			previous := points[len(points)-2]
			if previous.value != 0 {
				changePercent = (latest.value - previous.value) / previous.value * 100
			}
		}
		trend := "stable"
		switch {
		case changePercent > 5:
			trend = "rising"
		case changePercent < -5:
			trend = "falling"
		}
		countries := make([]string, 0)
		for _, token := range strings.Split(pair, "_") {
			if jsTrim(token) == "" {
				continue
			}
			code := strings.ToUpper(token)
			if mapped, ok := countryTokenToAlpha2[token]; ok {
				code = mapped
			}
			if code != "" {
				countries = append(countries, code)
			}
		}
		rows = append(rows, TensionRow{
			ID:            "gdelt:" + pair,
			Label:         strings.ToUpper(strings.ReplaceAll(pair, "_", " / ")),
			Score:         jsFixedNumber(latest.value, 3),
			ChangePercent: jsFixedNumber(changePercent, 3),
			Trend:         trend,
			Countries:     countries,
			UpdatedAt:     latest.ts,
		})
	}
	sort.SliceStable(rows, func(left, right int) bool {
		return rows[right].Score < rows[left].Score
	})
	return rows
}

func firstRawString(values ...jsonRawMessage) string {
	for _, value := range values {
		if text := normalizeStringRaw(value); text != "" {
			return text
		}
	}
	return ""
}

func finiteOr(raw jsonRawMessage, fallback float64) float64 {
	if value, ok := toFiniteNumber(raw); ok {
		return value
	}
	return fallback
}

func isNumberValue(raw jsonRawMessage) bool {
	if !isJSONNumber(raw) {
		return false
	}
	_, ok := toFiniteNumber(raw)
	return ok
}
