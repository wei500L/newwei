package dashboardwarmap

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// layersStamp 对应 Nest war-map-layers.ts 模块加载时的 UPDATED_AT。
var layersStamp = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

func (s *Service) Layers(ctx context.Context, orgID string, start, end time.Time, opt viewOptions) (map[string]any, error) {
	events, err := s.Events(ctx, orgID, start, end, viewOptions{})
	if err != nil {
		return nil, err
	}
	markers, err := s.Markers(ctx, orgID, start, end, viewOptions{})
	if err != nil {
		return nil, err
	}
	return s.layersFrom(ctx, orgID, opt, events, markers)
}

// layersFrom 用已经取到的事件和新闻标记补动态图层。HTTP layers 仍先自己查询；
// SSE 把同一次更新里的结果传进来，避免再查一遍。
func (s *Service) layersFrom(ctx context.Context, orgID string, opt viewOptions, events eventsResponse, markers markersResponse) (map[string]any, error) {
	response := staticLayers()
	if err := s.enrichFlights(ctx, response, orgID, opt); err != nil {
		return nil, err
	}
	if err := s.enrichAIS(ctx, response, orgID, opt); err != nil {
		return nil, err
	}
	mergeRealtimeLayers(response, events.Events, markers.Markers)
	if opt.Translate && s.words != nil {
		applyLayerTranslations(response, s.words.ToZH(ctx, layerTexts(response)))
	}
	return response, nil
}

type seedPoint struct {
	ID, Name, NameZh, Description, DescriptionZh, Timestamp, Corpus string
	Lat, Lng                                                         float64
}

func mergeRealtimeLayers(response map[string]any, events []warEvent, markers []newsMarker) {
	points := seedPoints(events, markers)
	if len(points) == 0 {
		return
	}
	layers, _ := response["layers"].(map[string]any)
	for _, layerID := range layerIDs {
		if layerID == "monitors" || layerID == "dayNight" || layerID == "flights" || layerID == "ais" {
			continue
		}
		dataset, _ := layers[layerID].(map[string]any)
		if dataset == nil {
			continue
		}
		geometry, _ := dataset["geometryType"].(string)
		generated := featuresFromSeeds(layerID, geometry, pickSeeds(layerID, points))
		if len(generated) == 0 {
			continue
		}
		existing, _ := dataset["features"].([]any)
		dataset["features"] = mergeFeatures(existing, generated, 240)
		hints, _ := dataset["renderHints"].(map[string]any)
		if hints == nil {
			hints = map[string]any{}
		}
		next := map[string]any{}
		for key, value := range hints {
			next[key] = value
		}
		next["pickable"] = true
		if _, ok := next["color"]; !ok {
			if color := layerColors[layerID]; color != "" {
				next["color"] = color
			}
		}
		if _, ok := next["clusterable"]; !ok {
			next["clusterable"] = geometry == "point" || geometry == "path"
		}
		if _, ok := next["radiusScale"]; !ok && geometry == "point" {
			next["radiusScale"] = 1
		}
		dataset["renderHints"] = next
	}
}

func seedPoints(events []warEvent, markers []newsMarker) []seedPoint {
	points := make([]seedPoint, 0, len(events)+len(markers))
	for _, event := range events {
		if math.IsNaN(event.Lat) || math.IsInf(event.Lat, 0) || math.IsNaN(event.Lng) || math.IsInf(event.Lng, 0) {
			continue
		}
		score := event.DerivedScore
		description := "severity=" + event.Severity + "; alerts=" + strconv.Itoa(event.AlertCount) + "; news=" + strconv.Itoa(event.NewsCount) + "; score=" + formatScore(score)
		points = append(points, seedPoint{
			ID: "evt-" + event.ID, Lat: event.Lat, Lng: event.Lng, Name: event.Name, NameZh: event.NameZh,
			Description: description, Timestamp: event.LatestAt,
			Corpus: strings.ToLower(event.Name + " " + event.NameZh + " " + description),
		})
	}
	for _, marker := range markers {
		if math.IsNaN(marker.Lat) || math.IsInf(marker.Lat, 0) || math.IsNaN(marker.Lng) || math.IsInf(marker.Lng, 0) {
			continue
		}
		name := strings.TrimSpace(marker.DisplayName)
		if name == "" {
			name = marker.Location
		}
		nameZh := strings.TrimSpace(marker.DisplayNameZh)
		if nameZh == "" {
			nameZh = marker.LocationZh
		}
		timestamp := marker.PublishedAt
		if timestamp == "" {
			timestamp = marker.IngestedAt
		}
		points = append(points, seedPoint{
			ID: "news-" + marker.ID, Lat: marker.Lat, Lng: marker.Lng, Name: name, NameZh: nameZh,
			Description: marker.Title, DescriptionZh: marker.TitleZh, Timestamp: timestamp,
			Corpus: strings.ToLower(name + " " + nameZh + " " + marker.Title + " " + marker.TitleZh + " " + marker.Location),
		})
	}
	return points
}

func formatScore(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func pickSeeds(layerID string, points []seedPoint) []seedPoint {
	if len(points) == 0 {
		return nil
	}
	keywords := layerKeywords[layerID]
	selected := make([]seedPoint, 0)
	if len(keywords) > 0 {
		for _, point := range points {
			for _, keyword := range keywords {
				if strings.Contains(point.Corpus, keyword) {
					selected = append(selected, point)
					break
				}
			}
		}
	} else {
		selected = append(selected, points...)
	}
	if len(selected) == 0 {
		seed := hashString(layerID)
		modulo := 2
		if extra := (seed % 7) + 2; extra > modulo {
			modulo = extra
		}
		for index, point := range points {
			if (index+seed)%modulo == 0 {
				selected = append(selected, point)
			}
		}
	}
	if len(selected) == 0 {
		limit := len(points)
		if limit > 24 {
			limit = 24
		}
		selected = append(selected, points[:limit]...)
	}
	sort.SliceStable(selected, func(i, j int) bool {
		return parseMillis(selected[i].Timestamp) > parseMillis(selected[j].Timestamp)
	})
	return selected
}

func hashString(value string) int {
	hash := int32(0)
	for _, r := range value {
		hash = (hash << 5) - hash + int32(r)
	}
	if hash < 0 {
		return int(-hash)
	}
	return int(hash)
}

func featuresFromSeeds(layerID, geometry string, points []seedPoint) []any {
	if len(points) == 0 || geometry == "raster" {
		return nil
	}
	if geometry == "path" {
		return pathFeatures(layerID, points)
	}
	if geometry == "polygon" {
		return polygonFeatures(layerID, points)
	}
	limit := len(points)
	if limit > 140 {
		limit = 140
	}
	out := make([]any, 0, limit)
	for index, point := range points[:limit] {
		out = append(out, map[string]any{
			"id": layerID + "-point-" + strconv.Itoa(index) + "-" + point.ID,
			"lat": point.Lat, "lng": point.Lng,
			"properties": seedProps(point, ""),
			"timestamp":  emptyOmit(point.Timestamp),
		})
	}
	return cleanFeatures(out)
}

func pathFeatures(layerID string, points []seedPoint) []any {
	if len(points) == 1 {
		point := points[0]
		feature := map[string]any{
			"id": layerID + "-path-0-" + point.ID,
			"path": []any{
				[]any{clampFinite(point.Lng-1.2, -180, 180), clampFinite(point.Lat-0.6, -90, 90)},
				[]any{clampFinite(point.Lng+1.2, -180, 180), clampFinite(point.Lat+0.6, -90, 90)},
			},
			"properties": seedProps(point, ""),
			"timestamp":  emptyOmit(point.Timestamp),
		}
		return cleanFeatures([]any{feature})
	}
	maxPaths := len(points) / 2
	if maxPaths > 24 {
		maxPaths = 24
	}
	out := make([]any, 0, maxPaths)
	for index := 0; index < maxPaths; index++ {
		from := points[index*2]
		to := points[index*2+1]
		nameZh := ""
		if from.NameZh != "" && to.NameZh != "" {
			nameZh = from.NameZh + " -> " + to.NameZh
		}
		description := from.Description
		if description == "" {
			description = to.Description
		}
		timestamp := from.Timestamp
		if timestamp == "" {
			timestamp = to.Timestamp
		}
		props := map[string]any{"name": from.Name + " -> " + to.Name}
		if nameZh != "" {
			props["nameZh"] = nameZh
		}
		if description != "" {
			props["description"] = description
		}
		out = append(out, map[string]any{
			"id": layerID + "-path-" + strconv.Itoa(index) + "-" + from.ID + "-" + to.ID,
			"path": []any{[]any{from.Lng, from.Lat}, []any{to.Lng, to.Lat}},
			"properties": props, "timestamp": emptyOmit(timestamp),
		})
	}
	return cleanFeatures(out)
}

func polygonFeatures(layerID string, points []seedPoint) []any {
	limit := len(points)
	if limit > 18 {
		limit = 18
	}
	out := make([]any, 0, limit)
	for index, point := range points[:limit] {
		offset := 0.8 + float64(index%3)*0.35
		minLng := clampFinite(point.Lng-offset, -180, 180)
		maxLng := clampFinite(point.Lng+offset, -180, 180)
		minLat := clampFinite(point.Lat-offset, -90, 90)
		maxLat := clampFinite(point.Lat+offset, -90, 90)
		out = append(out, map[string]any{
			"id": layerID + "-polygon-" + strconv.Itoa(index) + "-" + point.ID,
			"polygon": []any{[]any{
				[]any{minLng, minLat}, []any{maxLng, minLat}, []any{maxLng, maxLat}, []any{minLng, maxLat}, []any{minLng, minLat},
			}},
			"properties": seedProps(point, ""),
			"timestamp":  emptyOmit(point.Timestamp),
		})
	}
	return cleanFeatures(out)
}

func seedProps(point seedPoint, _ string) map[string]any {
	props := map[string]any{}
	if point.Name != "" {
		props["name"] = point.Name
	}
	if point.NameZh != "" {
		props["nameZh"] = point.NameZh
	}
	if point.Description != "" {
		props["description"] = point.Description
	}
	if point.DescriptionZh != "" {
		props["descriptionZh"] = point.DescriptionZh
	}
	return props
}

func emptyOmit(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func cleanFeatures(features []any) []any {
	out := make([]any, 0, len(features))
	for _, feature := range features {
		row, _ := feature.(map[string]any)
		if row == nil {
			continue
		}
		if row["timestamp"] == nil {
			delete(row, "timestamp")
		}
		out = append(out, row)
	}
	return out
}

func mergeFeatures(existing, incoming []any, maxItems int) []any {
	merged := make([]any, 0, maxItems)
	seen := map[string]struct{}{}
	appendOne := func(feature any) bool {
		row, _ := feature.(map[string]any)
		if row == nil {
			return false
		}
		id, _ := row["id"].(string)
		if _, ok := seen[id]; ok {
			return false
		}
		seen[id] = struct{}{}
		merged = append(merged, feature)
		return len(merged) >= maxItems
	}
	for _, feature := range existing {
		if appendOne(feature) {
			return merged
		}
	}
	for _, feature := range incoming {
		if appendOne(feature) {
			break
		}
	}
	return merged
}

func layerTexts(response map[string]any) []string {
	texts := make([]string, 0)
	add := func(value any) {
		text := cleanString(value)
		if text != "" {
			texts = append(texts, text)
		}
	}
	for _, key := range []string{"hotspots", "chokepoints", "cableLandings", "nuclearSites", "militaryBases"} {
		rows, _ := response[key].([]any)
		for _, row := range rows {
			item, _ := row.(map[string]any)
			add(item["name"])
			add(item["description"])
		}
	}
	zones, _ := response["conflictZones"].([]any)
	for _, row := range zones {
		item, _ := row.(map[string]any)
		add(item["name"])
	}
	layers, _ := response["layers"].(map[string]any)
	for _, layerID := range layerIDs {
		dataset, _ := layers[layerID].(map[string]any)
		features, _ := dataset["features"].([]any)
		for _, feature := range features {
			row, _ := feature.(map[string]any)
			props, _ := row["properties"].(map[string]any)
			add(props["name"])
			add(props["description"])
		}
	}
	return texts
}

func applyLayerTranslations(response map[string]any, translated map[string]string) {
	applyPair := func(item map[string]any, description bool) {
		if text := translated[cleanString(item["name"])]; text != "" {
			item["nameZh"] = text
		}
		if description {
			if text := translated[cleanString(item["description"])]; text != "" {
				item["descriptionZh"] = text
			}
		}
	}
	for _, key := range []string{"hotspots", "chokepoints", "cableLandings", "nuclearSites", "militaryBases"} {
		rows, _ := response[key].([]any)
		for _, row := range rows {
			item, _ := row.(map[string]any)
			applyPair(item, true)
		}
	}
	zones, _ := response["conflictZones"].([]any)
	for _, row := range zones {
		item, _ := row.(map[string]any)
		applyPair(item, false)
	}
	layers, _ := response["layers"].(map[string]any)
	for _, layerID := range layerIDs {
		dataset, _ := layers[layerID].(map[string]any)
		features, _ := dataset["features"].([]any)
		for _, feature := range features {
			row, _ := feature.(map[string]any)
			props, _ := row["properties"].(map[string]any)
			if props == nil {
				continue
			}
			if text := translated[cleanString(props["name"])]; text != "" {
				props["nameZh"] = text
			}
			if text := translated[cleanString(props["description"])]; text != "" {
				props["descriptionZh"] = text
			}
		}
	}
}
