package dashboardcharts

import (
	"bytes"
	_ "embed"
	"encoding/json"
)

//go:embed assets/world.geo.json
var worldGeoJSON []byte

// WorldGeoJSON 是编译进二进制的同一份 world.geo.json。
// War Map 国家中心点读它，不再嵌第二份底图。
func WorldGeoJSON() []byte {
	return worldGeoJSON
}

type geoAsset struct {
	body   []byte
	detail string
}

func newGeoAsset(raw []byte) geoAsset {
	body, detail, ok := buildGeoBody(raw)
	if !ok {
		if detail == "" {
			detail = geoJSONErrorDetail
		}
		return geoAsset{detail: detail}
	}
	return geoAsset{body: body}
}

func buildGeoBody(raw []byte) ([]byte, string, bool) {
	if !validFeatureCollection(raw) {
		return nil, geoJSONErrorDetail, false
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err.Error(), false
	}
	var body bytes.Buffer
	body.WriteString(`{"name":"world","geoJson":`)
	body.Write(compact.Bytes())
	body.WriteString(`,"center":[0,20],"zoom":1.1}`)
	return body.Bytes(), "", true
}

func validFeatureCollection(raw []byte) bool {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	kind, _ := payload["type"].(string)
	_, ok := payload["features"].([]any)
	return kind == "FeatureCollection" && ok
}
