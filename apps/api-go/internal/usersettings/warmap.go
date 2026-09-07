// War Map UI 设置的 normalization 契约（Go-批3B）。
//
// 权威来源是 packages/utils/src/war-map-contract.ts 的 normalizeWarMapSettings
//（499-528 行）——完整移植，不是只实现 smoke fixture 用到的字段：
//   - 全部 45 个 layer id 与默认 visibility（WAR_MAP_LAYER_IDS /
//     WAR_MAP_DEFAULT_LAYER_VISIBILITY）；
//   - legacy layer key 映射（LEGACY_WAR_MAP_LAYER_KEY_MAP：conflictZones→
//     conflicts 等 7 项——只在新 key 无布尔值时作 fallback）；
//   - viewState：lat clamp [-90,90]、lon clamp [-180,180]、zoom clamp
//     [0.5,18]，缺失/非有限数字回退默认（20/0/1.8）；bearing/pitch 强制
//     归零（契约如此，不读输入）；
//   - activePreset ∈ 8 个 preset，否则 "global"；timeRangePreset ∈ 6 个
//     preset，否则 "7d"；
//   - flightMode：仅 "all" 保留，其余 "military"；aisMode：all/density
//     保留，其余 "military"；
//   - aisHighlightCandidates：仅严格 false 为 false，其余（缺失/非布尔/
//     true）一律 true；
//   - layerVisibility 输入是「根对象的 layerVisibility 字段」或「根对象
//     本身」（record.layerVisibility 是非数组对象时用它，否则用 record）——
//     这是「对象但字段缺失」与「整体非对象」之间的既有默认差异：整体非
//     对象 → 全默认（不含任何输入字段）；对象 + layerVisibility 字段
//     缺失 → 逐 layer 读根对象自身。
//
// 存储 key：ui:war-map:settings:v1（WarMapKey，repository.go）。无记录 →
// settings null（repository/build 层语义，同其他端点）。
package usersettings

const (
	// warMapLayerCount 与 WAR_MAP_LAYER_IDS 长度一致（45）。
	warMapLayerCount = 45
	// warMapVisibilityLegacyCount 与 LEGACY_WAR_MAP_LAYER_KEY_MAP 条目数一致（7）。
	warMapVisibilityLegacyCount = 7
)

// warMapLayerIDs 与 WAR_MAP_LAYER_IDS 一一对应（顺序一致——序列化顺序
// 由 Go struct 固定，与 NestJS 展开顺序一致地按此声明顺序输出）。
var warMapLayerIDs = [warMapLayerCount]string{
	"conflicts", "bases", "cables", "pipelines", "hotspots", "ais",
	"nuclear", "irradiators", "sanctions", "weather", "economic", "waterways",
	"outages", "cyberThreats", "datacenters", "protests", "flights", "military",
	"natural", "spaceports", "minerals", "fires", "ucdpEvents", "displacement",
	"climate", "startupHubs", "cloudRegions", "accelerators", "techHQs", "techEvents",
	"stockExchanges", "financialCenters", "centralBanks", "commodityHubs", "gulfInvestments", "positiveEvents",
	"kindness", "happiness", "speciesRecovery", "renewableInstallations", "tradeRoutes", "iranAttacks",
	"gpsJamming", "dayNight", "monitors",
}

// warMapDefaultVisibility 与 WAR_MAP_DEFAULT_LAYER_VISIBILITY 一一对应。
var warMapDefaultVisibility = [warMapLayerCount]bool{
	true, true, false, false, true, true,
	true, false, true, true, true, true,
	true, false, false, false, true, true,
	true, false, false, false, false, false,
	false, false, false, false, false, false,
	false, false, false, false, false, false,
	false, false, false, false, false, true,
	false, false, true,
}

// warMapLegacyLayerKeys 与 LEGACY_WAR_MAP_LAYER_KEY_MAP 的 key 一一对应
//（与 warMapLayerIDs 平行数组：legacyKeys[i] 映射到 layerIDs[i]）。
var warMapLegacyLayerKeys = [warMapVisibilityLegacyCount]string{
	"conflictZones", "chokepoints", "cableLandings", "nuclearSites",
	"militaryBases", "hotspots", "monitors",
}

// warMapLegacyLayerTargets 与 LEGACY_WAR_MAP_LAYER_KEY_MAP 的 value 对应
//（legacyKeys[i] → warMapLegacyLayerTargets[i]）。
var warMapLegacyLayerTargets = [warMapVisibilityLegacyCount]string{
	"conflicts", "waterways", "cables", "nuclear",
	"bases", "hotspots", "monitors",
}

// warMapPresets 与 WAR_MAP_PRESETS 一致。
var warMapPresets = map[string]bool{
	"global": true, "america": true, "mena": true, "eu": true,
	"asia": true, "latam": true, "africa": true, "oceania": true,
}

// warMapTimeRangePresets 与 WAR_MAP_TIME_RANGE_PRESETS 一致。
var warMapTimeRangePresets = map[string]bool{
	"1h": true, "6h": true, "24h": true, "48h": true, "7d": true, "all": true,
}

// WarMapViewState 对齐 NestJS WarMapViewState（lat/lon/zoom + 强制归零的
// bearing/pitch）。
type WarMapViewState struct {
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Zoom    float64 `json:"zoom"`
	Bearing float64 `json:"bearing"`
	Pitch   float64 `json:"pitch"`
}

// WarMapSettings 对齐 NestJS WarMapSettings。LayerVisibility 用固定 45
// 字段 struct（不是 map）：序列化顺序与 NestJS 展开顺序一致，且编译期
// 封闭集合——不存在未知 layer。
type WarMapSettings struct {
	LayerVisibility       warMapLayerVisibility `json:"layerVisibility"`
	ViewState             WarMapViewState       `json:"viewState"`
	ActivePreset          string                `json:"activePreset"`
	TimeRangePreset       string                `json:"timeRangePreset"`
	FlightMode            string                `json:"flightMode"`
	AisMode               string                `json:"aisMode"`
	AisHighlightCandidates bool                 `json:"aisHighlightCandidates"`
}

// warMapLayerVisibility 是 45 个 layer 的固定字段 visibility（字段顺序与
// WAR_MAP_LAYER_IDS 一致）。
type warMapLayerVisibility struct {
	Conflicts            bool `json:"conflicts"`
	Bases                bool `json:"bases"`
	Cables               bool `json:"cables"`
	Pipelines            bool `json:"pipelines"`
	Hotspots             bool `json:"hotspots"`
	Ais                  bool `json:"ais"`
	Nuclear              bool `json:"nuclear"`
	Irradiators          bool `json:"irradiators"`
	Sanctions            bool `json:"sanctions"`
	Weather              bool `json:"weather"`
	Economic             bool `json:"economic"`
	Waterways            bool `json:"waterways"`
	Outages              bool `json:"outages"`
	CyberThreats         bool `json:"cyberThreats"`
	Datacenters          bool `json:"datacenters"`
	Protests             bool `json:"protests"`
	Flights              bool `json:"flights"`
	Military             bool `json:"military"`
	Natural              bool `json:"natural"`
	Spaceports           bool `json:"spaceports"`
	Minerals             bool `json:"minerals"`
	Fires                bool `json:"fires"`
	UcdpEvents           bool `json:"ucdpEvents"`
	Displacement         bool `json:"displacement"`
	Climate              bool `json:"climate"`
	StartupHubs          bool `json:"startupHubs"`
	CloudRegions         bool `json:"cloudRegions"`
	Accelerators         bool `json:"accelerators"`
	TechHQs              bool `json:"techHQs"`
	TechEvents           bool `json:"techEvents"`
	StockExchanges       bool `json:"stockExchanges"`
	FinancialCenters     bool `json:"financialCenters"`
	CentralBanks         bool `json:"centralBanks"`
	CommodityHubs        bool `json:"commodityHubs"`
	GulfInvestments      bool `json:"gulfInvestments"`
	PositiveEvents       bool `json:"positiveEvents"`
	Kindness             bool `json:"kindness"`
	Happiness            bool `json:"happiness"`
	SpeciesRecovery      bool `json:"speciesRecovery"`
	RenewableInstallations bool              `json:"renewableInstallations"`
	TradeRoutes          bool `json:"tradeRoutes"`
	IranAttacks          bool `json:"iranAttacks"`
	GpsJamming           bool `json:"gpsJamming"`
	DayNight             bool `json:"dayNight"`
	Monitors             bool `json:"monitors"`
}

// warMapVisibilityFields 把 visibility struct 转为平行切片（apply 输入用）。
func warMapVisibilityFields(v *warMapLayerVisibility) []*bool {
	return []*bool{
		&v.Conflicts, &v.Bases, &v.Cables, &v.Pipelines, &v.Hotspots, &v.Ais,
		&v.Nuclear, &v.Irradiators, &v.Sanctions, &v.Weather, &v.Economic, &v.Waterways,
		&v.Outages, &v.CyberThreats, &v.Datacenters, &v.Protests, &v.Flights, &v.Military,
		&v.Natural, &v.Spaceports, &v.Minerals, &v.Fires, &v.UcdpEvents, &v.Displacement,
		&v.Climate, &v.StartupHubs, &v.CloudRegions, &v.Accelerators, &v.TechHQs, &v.TechEvents,
		&v.StockExchanges, &v.FinancialCenters, &v.CentralBanks, &v.CommodityHubs, &v.GulfInvestments, &v.PositiveEvents,
		&v.Kindness, &v.Happiness, &v.SpeciesRecovery, &v.RenewableInstallations, &v.TradeRoutes, &v.IranAttacks,
		&v.GpsJamming, &v.DayNight, &v.Monitors,
	}
}

// WarMapResponse 是 GET /api/user-settings/ui/war-map 的响应体（settings
// 无记录时 null；updatedAt 同其他端点语义）。
type WarMapResponse struct {
	Version   int `json:"version"`
	UpdatedAt struct {
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Settings *WarMapSettings `json:"settings"`
}

// BuildWarMapResponse 输入数据库记录，输出完整响应。
func BuildWarMapResponse(record Record) WarMapResponse {
	var response WarMapResponse
	response.Version = 1
	if !record.Found {
		return response
	}
	response.UpdatedAt.Settings = formatJSISO(record.UpdatedAt)
	settings := NormalizeWarMap(record.Value)
	response.Settings = &settings
	return response
}

// NormalizeWarMap 复刻 normalizeWarMapSettings（war-map-contract.ts:499-528）。
func NormalizeWarMap(raw []byte) WarMapSettings {
	settings := defaultWarMap()

	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}

	settings.LayerVisibility = coerceWarMapLayerVisibility(value)
	settings.ViewState = normalizeWarMapViewState(value["viewState"])
	settings.ActivePreset = warMapPresetOr(value["activePreset"])
	settings.TimeRangePreset = warMapTimeRangePresetOr(value["timeRangePreset"])
	settings.FlightMode = warMapFlightModeOr(value["flightMode"])
	settings.AisMode = warMapAisModeOr(value["aisMode"])
	if b, isBool := value["aisHighlightCandidates"].(bool); isBool && !b {
		settings.AisHighlightCandidates = false
	}
	return settings
}

// defaultWarMap 是非对象输入的全默认（normalizeWarMapSettings 的第一分支）。
func defaultWarMap() WarMapSettings {
	visibility := defaultWarMapVisibility()
	return WarMapSettings{
		LayerVisibility:        visibility,
		ViewState:              WarMapViewState{Lat: 20, Lon: 0, Zoom: 1.8},
		ActivePreset:           "global",
		TimeRangePreset:        "7d",
		FlightMode:             "military",
		AisMode:                "all",
		AisHighlightCandidates: true,
	}
}

// defaultWarMapVisibility 从平行数组填充默认 visibility。
func defaultWarMapVisibility() warMapLayerVisibility {
	var visibility warMapLayerVisibility
	fields := warMapVisibilityFields(&visibility)
	for i := range warMapLayerIDs {
		*fields[i] = warMapDefaultVisibility[i]
	}
	return visibility
}

// coerceWarMapLayerVisibility 复刻 coerceWarMapLayerVisibility
//（465-497）：raw 是「根对象的 layerVisibility 字段值」；输入不是非数组
// 对象时用根对象自身（record.layerVisibility ?? record 语义——注意
// NestJS 的 ?? 只判 null/undefined，此处 value 来自 asJSONObject 保证是
// 对象）。逐 layer：新 key 有布尔值直接采用；否则查 legacy key 映射，
// legacy 值也是布尔才采用；否则保持默认。
func coerceWarMapLayerVisibility(record map[string]any) warMapLayerVisibility {
	visibility := defaultWarMapVisibility()

	rawVisibility := any(record)
	if nested, ok := record["layerVisibility"].(map[string]any); ok {
		rawVisibility = nested
	}
	rawRecord, _ := rawVisibility.(map[string]any)

	fields := warMapVisibilityFields(&visibility)
	for i, layerID := range warMapLayerIDs {
		if b, ok := rawRecord[layerID].(bool); ok {
			*fields[i] = b
			continue
		}
		// legacy key fallback（每层至多一个 legacy key 指向它）。
		for j, legacyKey := range warMapLegacyLayerKeys {
			if warMapLegacyLayerTargets[j] == layerID {
				if b, ok := rawRecord[legacyKey].(bool); ok {
					*fields[i] = b
				}
				break
			}
		}
	}
	return visibility
}

// normalizeWarMapViewState 复刻 normalizeWarMapViewState（439-453）。
func normalizeWarMapViewState(value any) WarMapViewState {
	viewState := WarMapViewState{Lat: 20, Lon: 0, Zoom: 1.8}
	record, ok := value.(map[string]any)
	if !ok {
		return viewState
	}
	if f, ok := record["lat"].(float64); ok {
		viewState.Lat = clampFloatValue(f, -90, 90)
	}
	if f, ok := record["lon"].(float64); ok {
		viewState.Lon = clampFloatValue(f, -180, 180)
	}
	if f, ok := record["zoom"].(float64); ok {
		viewState.Zoom = clampFloatValue(f, 0.5, 18)
	}
	// bearing/pitch 强制归零（共享契约的平相机语义——不读输入值）。
	return viewState
}

// clampFloatValue：clamp 到 [min, max]（输入已是有限数字——JSON 解码
// 的 float64 与 JS number 同语义，无 NaN/Infinity 分支）。
func clampFloatValue(f, min, max float64) float64 {
	if f < min {
		return min
	}
	if f > max {
		return max
	}
	return f
}

// warMapPresetOr：合法 preset 保留，否则 "global"。
func warMapPresetOr(value any) string {
	if s, ok := value.(string); ok && warMapPresets[s] {
		return s
	}
	return "global"
}

// warMapTimeRangePresetOr：合法值保留，否则 "7d"。
func warMapTimeRangePresetOr(value any) string {
	if s, ok := value.(string); ok && warMapTimeRangePresets[s] {
		return s
	}
	return "7d"
}

// warMapFlightModeOr：仅 "all" 保留，其余 "military"。
func warMapFlightModeOr(value any) string {
	if s, ok := value.(string); ok && s == "all" {
		return "all"
	}
	return "military"
}

// warMapAisModeOr：all/density 保留，其余 "military"。
func warMapAisModeOr(value any) string {
	if s, ok := value.(string); ok {
		switch s {
		case "all", "density":
			return s
		}
	}
	return "military"
}
