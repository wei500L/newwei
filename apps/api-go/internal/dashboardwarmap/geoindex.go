package dashboardwarmap

import (
	"encoding/json"
	"math"
	"sync"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

type geoPoint struct {
	Name string
	Lat  float64
	Lng  float64
}

type geoIndex struct {
	byCode map[string]geoPoint
}

var (
	geoOnce  sync.Once
	geoCache *geoIndex
)

func worldIndex() *geoIndex {
	geoOnce.Do(func() {
		geoCache = buildGeoIndex(dashboardcharts.WorldGeoJSON())
	})
	return geoCache
}

func buildGeoIndex(raw []byte) *geoIndex {
	idx := &geoIndex{byCode: map[string]geoPoint{}}
	var payload struct {
		Features []struct {
			ID         any `json:"id"`
			Properties struct {
				Name string `json:"name"`
			} `json:"properties"`
			Geometry *struct {
				Type        string `json:"type"`
				Coordinates any    `json:"coordinates"`
				Geometries  []struct {
					Coordinates any `json:"coordinates"`
				} `json:"geometries"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return idx
	}
	for _, feature := range payload.Features {
		name := feature.Properties.Name
		if name == "" || feature.Geometry == nil {
			continue
		}
		id, _ := feature.ID.(string)
		code := normalizeCountryCode(id)
		if code == "" {
			code = normalizeCountryCode(name)
		}
		if code == "" {
			continue
		}
		var positions [][2]float64
		if feature.Geometry.Type == "GeometryCollection" {
			for _, child := range feature.Geometry.Geometries {
				collectPositions(child.Coordinates, &positions)
			}
		} else {
			collectPositions(feature.Geometry.Coordinates, &positions)
		}
		lat, lng, ok := centroid(positions)
		if !ok {
			continue
		}
		idx.byCode[code] = geoPoint{Name: name, Lat: lat, Lng: lng}
	}
	return idx
}

func (g *geoIndex) get(code string) (geoPoint, bool) {
	if g == nil {
		return geoPoint{}, false
	}
	point, ok := g.byCode[code]
	return point, ok
}

func collectPositions(input any, positions *[][2]float64) {
	arr, ok := input.([]any)
	if !ok || len(arr) == 0 {
		return
	}
	if len(arr) >= 2 {
		lng, okLng := asFloat(arr[0])
		lat, okLat := asFloat(arr[1])
		if okLng && okLat {
			*positions = append(*positions, [2]float64{lng, lat})
			return
		}
	}
	for _, entry := range arr {
		collectPositions(entry, positions)
	}
}

func asFloat(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case json.Number:
		parsed, err := n.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func centroid(positions [][2]float64) (float64, float64, bool) {
	if len(positions) == 0 {
		return 0, 0, false
	}
	hasFarWest := false
	hasFarEast := false
	for _, pos := range positions {
		if pos[0] < -90 {
			hasFarWest = true
		}
		if pos[0] > 90 {
			hasFarEast = true
		}
	}
	wrap := 0.0
	if hasFarWest && hasFarEast {
		wrap = 360
	}
	minLng := math.Inf(1)
	maxLng := math.Inf(-1)
	minLat := math.Inf(1)
	maxLat := math.Inf(-1)
	for _, pos := range positions {
		lng, lat := pos[0], pos[1]
		if math.IsNaN(lng) || math.IsInf(lng, 0) || math.IsNaN(lat) || math.IsInf(lat, 0) {
			continue
		}
		if wrap > 0 && lng < 0 {
			lng += wrap
		}
		minLng = math.Min(minLng, lng)
		maxLng = math.Max(maxLng, lng)
		minLat = math.Min(minLat, lat)
		maxLat = math.Max(maxLat, lat)
	}
	if math.IsInf(minLng, 0) || math.IsInf(minLat, 0) {
		return 0, 0, false
	}
	centerLng := (minLng + maxLng) / 2
	if centerLng > 180 {
		centerLng -= 360
	}
	return (minLat + maxLat) / 2, centerLng, true
}
