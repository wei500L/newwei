package dashboardwarmap

import "math"

const (
	defaultClusterZoom = 2
	maxClusterZoom     = 16
)

var defaultBBox = [4]float64{-180, -85, 180, 85}

func clampFinite(value, min, max float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func clusterZoom(zoom *float64) int {
	normalized := defaultClusterZoom
	if zoom != nil && !math.IsNaN(*zoom) && !math.IsInf(*zoom, 0) {
		normalized = int(math.Round(*zoom))
	}
	if normalized < 0 {
		return 0
	}
	if normalized > maxClusterZoom {
		return maxClusterZoom
	}
	return normalized
}

func clusterCellSize(zoom *float64) float64 {
	scale := math.Pow(2, float64(clusterZoom(zoom))/2)
	return clampFinite(24/scale, 0.35, 32)
}

func clusterBBox(box *[4]float64) [4]float64 {
	if box == nil {
		return defaultBBox
	}
	return [4]float64{
		clampFinite(box[0], -180, 180),
		clampFinite(box[1], -90, 90),
		clampFinite(box[2], -180, 180),
		clampFinite(box[3], -90, 90),
	}
}

func insideBBox(lat, lng float64, box [4]float64) bool {
	return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3]
}

func cellKey(lat, lng float64, box [4]float64, cell float64) string {
	x := int(math.Floor((lng - box[0]) / cell))
	y := int(math.Floor((lat - box[1]) / cell))
	return itoa(x) + ":" + itoa(y)
}

func itoa(n int) string {
	return strconvItoa(n)
}

func filterEvents(events []warEvent, box *[4]float64) []warEvent {
	if box == nil {
		return events
	}
	out := make([]warEvent, 0, len(events))
	for _, event := range events {
		if insideBBox(event.Lat, event.Lng, *box) {
			out = append(out, event)
		}
	}
	return out
}

func filterMarkers(markers []newsMarker, box *[4]float64) []newsMarker {
	if box == nil {
		return markers
	}
	out := make([]newsMarker, 0, len(markers))
	for _, marker := range markers {
		if insideBBox(marker.Lat, marker.Lng, *box) {
			out = append(out, marker)
		}
	}
	return out
}

func clusterEvents(events []warEvent, opt viewOptions) []warEvent {
	filtered := filterEvents(events, opt.BBox)
	if !opt.Cluster {
		return filtered
	}
	grid := clusterBBox(opt.BBox)
	filtered = filterEvents(filtered, &grid)
	if len(filtered) == 0 {
		return []warEvent{}
	}
	cell := clusterCellSize(opt.Zoom)
	type group struct {
		id         int
		events     []warEvent
		weight     float64
		latW       float64
		lngW       float64
		maxRank    int
		score      float64
		alertScore float64
		alertCount int
		newsCount  int
		latest     int64
	}
	order := make([]string, 0)
	groups := map[string]*group{}
	nextID := 1
	for _, event := range filtered {
		key := cellKey(event.Lat, event.Lng, grid, cell)
		item := groups[key]
		if item == nil {
			item = &group{id: nextID}
			nextID++
			groups[key] = item
			order = append(order, key)
		}
		weight := event.DerivedScore
		if weight < 1 {
			weight = 1
		}
		item.events = append(item.events, event)
		item.weight += weight
		item.latW += event.Lat * weight
		item.lngW += event.Lng * weight
		rank := severityRank(event.Severity)
		if rank == 0 {
			rank = 1
		}
		if rank > item.maxRank {
			item.maxRank = rank
		}
		item.score += event.DerivedScore
		item.alertScore += event.AlertScore
		item.alertCount += event.AlertCount
		item.newsCount += event.NewsCount
		if ms := parseMillis(event.LatestAt); ms > item.latest {
			item.latest = ms
		}
	}
	out := make([]warEvent, 0, len(order))
	for _, key := range order {
		item := groups[key]
		if len(item.events) <= 1 {
			out = append(out, item.events[0])
			continue
		}
		rank := item.maxRank
		if rank < 1 {
			rank = 1
		}
		lat := item.events[0].Lat
		lng := item.events[0].Lng
		if item.weight > 0 {
			lat = item.latW / item.weight
			lng = item.lngW / item.weight
		}
		score := jsFixed2(item.score)
		clusterID := item.id
		count := len(item.events)
		out = append(out, warEvent{
			ID:           "cluster-" + itoa(item.id),
			Name:         "Cluster (" + itoa(count) + ")",
			Lat:          clampFinite(lat, -90, 90),
			Lng:          clampFinite(lng, -180, 180),
			Severity:     severityByRank(rank),
			LatestAt:     millisISO(item.latest),
			DerivedScore: score,
			Value:        score,
			AlertScore:   jsFixed2(item.alertScore),
			AlertCount:   item.alertCount,
			NewsCount:    item.newsCount,
			IsCluster:    true,
			ClusterID:    &clusterID,
			ClusterCount: &count,
		})
	}
	return out
}

func clusterMarkers(markers []newsMarker, opt viewOptions) []newsMarker {
	filtered := filterMarkers(markers, opt.BBox)
	if !opt.Cluster {
		return filtered
	}
	grid := clusterBBox(opt.BBox)
	filtered = filterMarkers(filtered, &grid)
	if len(filtered) == 0 {
		return []newsMarker{}
	}
	cell := clusterCellSize(opt.Zoom)
	type group struct {
		id      int
		markers []newsMarker
		lat     float64
		lng     float64
		latest  int64
	}
	order := make([]string, 0)
	groups := map[string]*group{}
	nextID := 1
	for _, marker := range filtered {
		key := cellKey(marker.Lat, marker.Lng, grid, cell)
		item := groups[key]
		if item == nil {
			item = &group{id: nextID}
			nextID++
			groups[key] = item
			order = append(order, key)
		}
		item.markers = append(item.markers, marker)
		item.lat += marker.Lat
		item.lng += marker.Lng
		stamp := marker.PublishedAt
		if stamp == "" {
			stamp = marker.IngestedAt
		}
		if ms := parseMillis(stamp); ms > item.latest {
			item.latest = ms
		}
	}
	out := make([]newsMarker, 0, len(order))
	for _, key := range order {
		item := groups[key]
		if len(item.markers) <= 1 {
			out = append(out, item.markers[0])
			continue
		}
		count := len(item.markers)
		clusterID := item.id
		out = append(out, newsMarker{
			ID:           "cluster-" + itoa(item.id),
			Title:        "Cluster (" + itoa(count) + ")",
			Location:     "Multiple locations",
			Lat:          clampFinite(item.lat/float64(count), -90, 90),
			Lng:          clampFinite(item.lng/float64(count), -180, 180),
			GeoSource:    "geocoded",
			PublishedAt:  millisISO(item.latest),
			IsCluster:    true,
			ClusterID:    &clusterID,
			ClusterCount: &count,
			URLPresent:   false,
		})
	}
	return out
}
