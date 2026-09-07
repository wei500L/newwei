// Go-批3B 新增三个 normalization 的代表性契约测试（任务书最小策略：
// 本文件是本轮唯一新增测试文件，Situation Monitor / War Map / NewsNow
// 各一个代表性契约，允许合并成表格——此处按端点分三个顶层测试函数，
// 加有序对象语义一个，共四个，未超过 5 个上限）。
//
// 覆盖原则：每个端点选「最能区分移植是否忠实」的组合（多字段联合
// 规整 + 边界回退），不逐字段/逐枚举/逐错误分支造测试。
package usersettings

import (
	"encoding/json"
	"testing"
	"time"
)

// Situation Monitor 契约：三记录聚合响应形态 + monitors/layout/settings
// 各自的代表性规整（fixture 提供稳定 id/createdAt——随机 fallback 由
// 实现保证，不加入 ignore 集）。
func TestSituationMonitorContract(t *testing.T) {
	// 无任何记录：三段 null、updatedAt 空——聚合语义的核心。
	t.Run("no records yield all null", func(t *testing.T) {
		body, err := json.Marshal(BuildSituationMonitorResponse(SituationMonitorRecords{}))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-records", string(body),
			`{"version":1,"updatedAt":{},"monitors":null,"layout":null,"settings":null}`)
	})

	// 部分记录（只有 settings）：updatedAt 只含 settings；monitors/layout
	// 仍 null——findMany 聚合语义（无记录 ≠ 默认值）。
	t.Run("partial records omit absent updatedAt keys", func(t *testing.T) {
		records := SituationMonitorRecords{
			Settings: Record{
				Found:     true,
				Value:     []byte(`{"windowHours":6,"scope":"tagged","autoRefresh":false,"resetLayoutOnPreset":"x","translateToZh":1}`),
				UpdatedAt: time.Date(2026, 9, 5, 12, 0, 0, 456000000, time.UTC),
			},
		}
		body, err := json.Marshal(BuildSituationMonitorResponse(records))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "partial", string(body),
			`{"version":1,"updatedAt":{"settings":"2026-09-05T12:00:00.456Z"},"monitors":null,"layout":null,`+
				`"settings":{"windowHours":6,"scope":"tagged","autoRefresh":false,"resetLayoutOnPreset":false,"translateToZh":false}}`)
	})

	// 三记录聚合 + 各段代表性规整：monitors（id/keywords/color/location/
	// enabled/createdAt）、layout（断点/legacy 回退/数值取整/visibility）、
	// settings（枚举与布尔回退）。
	t.Run("full aggregation with representative normalization", func(t *testing.T) {
		records := SituationMonitorRecords{
			Monitors: Record{
				Found: true,
				Value: []byte(`[
					{"id":"  mon-1  ","name":"  Taiwan Strait  ","keywords":[" ship , navy ","ship","MISSING",""],"enabled":0,
					 "color":" FF00AA ","location":{"name":" Taipei ","lat":25.03,"lng":121.56},"createdAt":1757000000000},
					{"name":"","keywords":["x"]},
					{"name":"NoKeywords","keywords":[]},
					{"name":"Bad location","keywords":["y"],"location":{"name":"L","lat":999,"lng":0}}
				]`),
				UpdatedAt: time.Date(2026, 9, 5, 13, 0, 0, 0, time.UTC),
			},
			Layout: Record{
				Found: true,
				Value: []byte(`{
					"layout": [{"i":" legacy-1 ","x":-3.2,"y":2.7,"w":0.4,"h":5.1,"minW":0,"static":true},{"i":"","x":1,"y":1,"w":1,"h":1}],
					"layouts": {"md": [{"i":" md-1 ","x":"a","y":1.5,"w":2.9,"minH":-2}], "bogus": [{"i":"x"}]},
					"visibility": {" panel-1 ":true,"panel-2":"yes","":false,"panel-3":false}
				}`),
				UpdatedAt: time.Date(2026, 9, 5, 14, 0, 0, 0, time.UTC),
			},
			Settings: Record{
				Found: true,
				Value: []byte(`{"windowHours":48,"scope":"everything","autoRefresh":0,"resetLayoutOnPreset":true,"translateToZh":true}`),
				UpdatedAt: time.Date(2026, 9, 5, 15, 0, 0, 789000000, time.UTC),
			},
		}
		response := BuildSituationMonitorResponse(records)

		// monitors：4 条输入中 #2（name 空）与 #3（无 keywords）整条丢弃；
		// #4（location lat=999 越界）location 不出现但 monitor 保留 → 2 条。
		if len(response.Monitors) != 2 {
			t.Fatalf("monitors = %d, want 2（name 空/无 keywords 整条丢弃；location 越界仅丢 location）: %+v", len(response.Monitors), response.Monitors)
		}
		first := response.Monitors[0]
		if first.ID != "mon-1" || first.Name != "Taiwan Strait" {
			t.Errorf("monitor[0] id/name = %q/%q, want mon-1/Taiwan Strait（trim+截断）", first.ID, first.Name)
		}
		wantKeywords := []string{"ship", "navy", "MISSING"}
		if len(first.Keywords) != len(wantKeywords) {
			t.Fatalf("keywords = %v, want %v（split/trim/去空/去重）", first.Keywords, wantKeywords)
		}
		for i, want := range wantKeywords {
			if first.Keywords[i] != want {
				t.Errorf("keywords[%d] = %q, want %q", i, first.Keywords[i], want)
			}
		}
		if !first.Enabled {
			t.Error("enabled = false, want true（数字 0 非布尔 → NestJS 缺省 true）")
		}
		if first.Color == nil || *first.Color != "#ff00aa" {
			t.Errorf("color = %v, want #ff00aa（补 #/小写）", first.Color)
		}
		if first.Location == nil || first.Location.Name != "Taipei" || first.Location.Lat != 25.03 || first.Location.Lng != 121.56 {
			t.Errorf("location = %+v, want Taipei/25.03/121.56", first.Location)
		}
		if first.CreatedAt != 1757000000000 {
			t.Errorf("createdAt = %d, want 1757000000000", first.CreatedAt)
		}
		if response.Monitors[1].Location != nil {
			t.Errorf("越界 location 应不出现: %+v", response.Monitors[1].Location)
		}
		if response.Monitors[1].Name != "Bad location" {
			t.Errorf("monitors[1].name = %q, want Bad location", response.Monitors[1].Name)
		}

		// layout：legacy `layout` 回退到 lg；md 断点数值取整与最小值。
		if response.Layout == nil {
			t.Fatal("layout = nil, want object")
		}
		lg := response.Layout.Layouts["lg"]
		if len(lg) != 1 {
			t.Fatalf("lg items = %d, want 1（空 i 丢弃；legacy 回退）", len(lg))
		}
		if lg[0].I != "legacy-1" || lg[0].X != 0 || lg[0].Y != 3 || lg[0].W != 1 || lg[0].H != 5 {
			t.Errorf("lg[0] = %+v, want i=legacy-1 x=0 y=3 w=1 h=5（负数/最小值/取整）", lg[0])
		}
		if lg[0].MinW == nil || *lg[0].MinW != 1 {
			t.Errorf("lg[0].minW = %v, want 1（0 → 最小值 1）", lg[0].MinW)
		}
		if lg[0].IsStatic == nil || !*lg[0].IsStatic {
			t.Errorf("lg[0].static = %v, want true", lg[0].IsStatic)
		}
		md := response.Layout.Layouts["md"]
		if len(md) != 1 || md[0].X != 0 || md[0].Y != 2 || md[0].W != 3 || md[0].MinH == nil || *md[0].MinH != 1 {
			t.Errorf("md[0] = %+v, want x=0 y=2 w=3 minH=1（非数字回退/取整/最小值）", md)
		}
		if _, exists := response.Layout.Layouts["bogus"]; exists {
			t.Error("未知断点不得写入 layouts")
		}
		// visibility：布尔项保留（trim key），非布尔丢弃；key trim。
		if len(response.Layout.Visibility) != 2 ||
			!response.Layout.Visibility["panel-1"] || response.Layout.Visibility["panel-3"] {
			t.Errorf("visibility = %v, want {panel-1:true, panel-3:false}（trim/布尔过滤）", response.Layout.Visibility)
		}

		// settings：windowHours 48 非法 → 24；scope 非法 → all；布尔严格。
		if response.Settings.WindowHours != 24 || response.Settings.Scope != "all" ||
			response.Settings.AutoRefresh || !response.Settings.ResetLayoutOnPreset || !response.Settings.TranslateToZh {
			t.Errorf("settings = %+v, want windowHours=24 scope=all autoRefresh=false reset=true translate=true", response.Settings)
		}

		// updatedAt 三段与三份数据对应。
		if response.UpdatedAt.Monitors != "2026-09-05T13:00:00.000Z" ||
			response.UpdatedAt.Layout != "2026-09-05T14:00:00.000Z" ||
			response.UpdatedAt.Settings != "2026-09-05T15:00:00.789Z" {
			t.Errorf("updatedAt = %+v（三段各自对应）", response.UpdatedAt)
		}
	})
}

// War Map 契约：完整移植 war-map-contract.ts 的代表性组合——layer
// visibility（新 key/legacy key/默认值三分支）、viewState clamp、枚举
// 回退、bearing/pitch 归零。无记录 → null。
func TestWarMapContract(t *testing.T) {
	t.Run("no record yields settings null", func(t *testing.T) {
		body, err := json.Marshal(BuildWarMapResponse(Record{Found: false}))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-record", string(body), `{"version":1,"updatedAt":{},"settings":null}`)
	})

	t.Run("non-object value yields full defaults", func(t *testing.T) {
		record := Record{Found: true, Value: []byte(`[1]`), UpdatedAt: time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)}
		settings := NormalizeWarMap(record.Value)
		// 抽查默认：known-true / known-false / flightMode / viewState。
		if !settings.LayerVisibility.Conflicts || settings.LayerVisibility.Cables ||
			!settings.LayerVisibility.Monitors || !settings.LayerVisibility.IranAttacks {
			t.Errorf("default layerVisibility mismatch: %+v", settings.LayerVisibility)
		}
		if settings.FlightMode != "military" || settings.AisMode != "all" || !settings.AisHighlightCandidates {
			t.Errorf("defaults: flightMode=%s aisMode=%s highlight=%v", settings.FlightMode, settings.AisMode, settings.AisHighlightCandidates)
		}
		if settings.ViewState.Lat != 20 || settings.ViewState.Lon != 0 || settings.ViewState.Zoom != 1.8 {
			t.Errorf("default viewState = %+v", settings.ViewState)
		}
	})

	t.Run("root-level visibility with legacy keys and clamps", func(t *testing.T) {
		raw := []byte(`{
			"conflicts": false,
			"militaryBases": false,
			"cables": true,
			"viewState": {"lat": 120, "lon": -200, "zoom": 99, "bearing": 45, "pitch": 30},
			"activePreset": "mena",
			"timeRangePreset": "48h",
			"flightMode": "all",
			"aisMode": "density",
			"aisHighlightCandidates": false
		}`)
		settings := NormalizeWarMap(raw)
		// 新 key 直接采用。
		if settings.LayerVisibility.Conflicts {
			t.Error("conflicts = true, want false（根对象直读）")
		}
		if settings.LayerVisibility.Cables {
			// cables 根对象给了 true——注意：cables 的 legacy key 是
			// cableLandings，这里 "cables" 是新 key，true 应被采用。
			t.Error("cables = false, want true（新 key 布尔值采用）")
		}
		// legacy key：militaryBases=false → bases=false（无新 key 时回退）。
		if settings.LayerVisibility.Bases {
			t.Error("bases = true, want false（legacy militaryBases 回退）")
		}
		// 未提及的 layer 保持默认（hotspots 默认 true；dayNight 默认 false）。
		if !settings.LayerVisibility.Hotspots || settings.LayerVisibility.DayNight {
			t.Errorf("untouched layers must keep defaults: hotspots=%v dayNight=%v",
				settings.LayerVisibility.Hotspots, settings.LayerVisibility.DayNight)
		}
		// viewState clamp + bearing/pitch 归零。
		if settings.ViewState.Lat != 90 || settings.ViewState.Lon != -180 || settings.ViewState.Zoom != 18 {
			t.Errorf("viewState = %+v, want lat=90 lon=-180 zoom=18（clamp）", settings.ViewState)
		}
		if settings.ViewState.Bearing != 0 || settings.ViewState.Pitch != 0 {
			t.Errorf("bearing/pitch = %v/%v, want 0/0（强制归零）", settings.ViewState.Bearing, settings.ViewState.Pitch)
		}
		// 枚举。
		if settings.ActivePreset != "mena" || settings.TimeRangePreset != "48h" ||
			settings.FlightMode != "all" || settings.AisMode != "density" || settings.AisHighlightCandidates {
			t.Errorf("enums: %+v", settings)
		}
	})

	t.Run("nested layerVisibility and invalid enums", func(t *testing.T) {
		raw := []byte(`{
			"layerVisibility": {"hotspots": false, "conflictZones": true},
			"viewState": "not-an-object",
			"activePreset": "atlantis",
			"timeRangePreset": "1y",
			"flightMode": "everything",
			"aisMode": "all",
			"aisHighlightCandidates": "false"
		}`)
		settings := NormalizeWarMap(raw)
		// 嵌套 layerVisibility：hotspots=false 采用；conflictZones（legacy）
		// 不在嵌套对象里 → conflicts 保持默认 true。
		if settings.LayerVisibility.Hotspots {
			t.Error("hotspots = true, want false（嵌套对象采用）")
		}
		if !settings.LayerVisibility.Conflicts {
			t.Error("conflicts = false, want true（嵌套对象里的 legacy key 不参与——只在缺失新 key 时从同一 raw 对象读）")
		}
		if settings.ViewState.Lat != 20 || settings.ViewState.Zoom != 1.8 {
			t.Errorf("viewState = %+v, want 默认（非对象回退）", settings.ViewState)
		}
		if settings.ActivePreset != "global" || settings.TimeRangePreset != "7d" || settings.FlightMode != "military" {
			t.Errorf("invalid enums must fall back: %+v", settings)
		}
		if !settings.AisHighlightCandidates {
			t.Error("aisHighlightCandidates = false, want true（字符串 \"false\" 非严格 false）")
		}
	})
}

// NewsNow 契约：有序对象（columnOrders/sourceAffinity 的 key 顺序 +
// 上限即停止）、source id pattern、Boolean 真值、clamp/round、
// smart→personalized。无记录 → null；非对象 → 默认（含 {} 形态）。
func TestNewsnowContract(t *testing.T) {
	t.Run("no record yields settings null", func(t *testing.T) {
		body, err := json.Marshal(BuildNewsnowResponse(Record{Found: false}))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-record", string(body), `{"version":1,"updatedAt":{},"settings":null}`)
	})

	t.Run("non-object value yields defaults as empty objects", func(t *testing.T) {
		record := Record{Found: true, Value: []byte(`42`), UpdatedAt: time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)}
		body, err := json.Marshal(BuildNewsnowResponse(record))
		if err != nil {
			t.Fatal(err)
		}
		// columnOrders/sourceAffinity 必须是 {}（不是 []——JS 对象序列化）。
		assertJSONEqual(t, "defaults", string(body),
			`{"version":1,"updatedAt":{"settings":"2026-09-05T00:00:00.000Z"},`+
				`"settings":{"focusSources":[],"columnOrders":{},"hideCrossSourceDuplicates":false,`+
				`"sortMode":"manual","densityMode":"compact","sourceAffinity":{}}}`)
	})

	t.Run("ordered objects, truthiness, clamps and dedupe", func(t *testing.T) {
		raw := []byte(`{
			"focusSources": [" src-A ", "src-A", "src-B!", "src-c", 42, ""],
			"columnOrders": {" zz-col ": [" s2 ", "s1", "s1"], "bad col!": ["s1"], "empty-col": [], "aa-col": ["s0"]},
			"hideCrossSourceDuplicates": "yes",
			"sortMode": "smart",
			"densityMode": "compact",
			"sourceAffinity": {" src-Z ": {"score": 250.5, "openOriginalCount": -5, "focusCount": 3.7, "lastInteractedAt": 12345678901234}, "src-Y": "not-an-object", "src-X": {"score": "high", "accumulatedDwellMs": 1e12}}
		}`)
		settings := NormalizeNewsnow(raw)

		// focusSources：trim/pattern 过滤（src-B! 非法）/去重/类型过滤。
		wantFocus := []string{"src-A", "src-c"}
		if len(settings.FocusSources) != len(wantFocus) {
			t.Fatalf("focusSources = %v, want %v", settings.FocusSources, wantFocus)
		}
		for i, want := range wantFocus {
			if settings.FocusSources[i] != want {
				t.Errorf("focusSources[%d] = %q, want %q", i, settings.FocusSources[i], want)
			}
		}

		// columnOrders：顺序保留（zz-col 在 aa-col 之前——出现顺序），
		// 非法 key 丢弃，空列表列丢弃。
		if len(settings.ColumnOrders) != 2 {
			t.Fatalf("columnOrders = %d entries, want 2: %+v", len(settings.ColumnOrders), settings.ColumnOrders)
		}
		if settings.ColumnOrders[0].Key != "zz-col" || settings.ColumnOrders[1].Key != "aa-col" {
			t.Errorf("columnOrders keys = [%s %s], want [zz-col aa-col]（出现顺序）",
				settings.ColumnOrders[0].Key, settings.ColumnOrders[1].Key)
		}
		if got := settings.ColumnOrders[0].Values; len(got) != 2 || got[0] != "s2" || got[1] != "s1" {
			t.Errorf("zz-col values = %v, want [s2 s1]（trim/去重）", got)
		}

		// hideCrossSourceDuplicates：非空字符串真值。
		if !settings.HideCrossSourceDuplicates {
			t.Error("hideCrossSourceDuplicates = false, want true（JS Boolean(\"yes\")）")
		}
		// smart → personalized 归一。
		if settings.SortMode != "personalized" {
			t.Errorf("sortMode = %q, want personalized（smart 归一）", settings.SortMode)
		}

		// sourceAffinity：顺序保留（src-Z 在 src-X 前），非法 value 丢弃，
		// clamp + round。
		if len(settings.SourceAffinity) != 2 {
			t.Fatalf("sourceAffinity = %d entries, want 2: %+v", len(settings.SourceAffinity), settings.SourceAffinity)
		}
		if settings.SourceAffinity[0].Key != "src-Z" || settings.SourceAffinity[1].Key != "src-X" {
			t.Errorf("sourceAffinity keys = [%s %s], want [src-Z src-X]（出现顺序）",
				settings.SourceAffinity[0].Key, settings.SourceAffinity[1].Key)
		}
		z := settings.SourceAffinity[0].Affinity
		if z.Score != 100 || z.OpenOriginalCount != 0 || z.FocusCount != 4 || z.LastInteractedAt != 9999999999999 {
			t.Errorf("src-Z affinity = %+v, want score=100(250.5 clamp) openOriginal=0(-5 clamp) focus=4(3.7 round) lastAt=9999999999999(clamp)", z)
		}
		x := settings.SourceAffinity[1].Affinity
		if x.Score != 0 || x.AccumulatedDwellMs != 31536000000 {
			t.Errorf("src-X affinity = %+v, want score=0(非数字) dwell=31536000000(1e12 clamp 到 365 天)", x)
		}

		// 序列化：对象形态 + 顺序保持（JSON 字符串断言）。
		body, err := json.Marshal(settings)
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "newsnow-shape", string(body),
			`{"focusSources":["src-A","src-c"],"columnOrders":{"zz-col":["s2","s1"],"aa-col":["s0"]},`+
				`"hideCrossSourceDuplicates":true,"sortMode":"personalized","densityMode":"compact",`+
				`"sourceAffinity":{"src-Z":{"score":100,"openOriginalCount":0,"openEventCount":0,"openItemCount":0,`+
				`"refreshCount":0,"focusCount":4,"accumulatedDwellMs":0,"lastInteractedAt":9999999999999},`+
				`"src-X":{"score":0,"openOriginalCount":0,"openEventCount":0,"openItemCount":0,`+
				`"refreshCount":0,"focusCount":0,"accumulatedDwellMs":31536000000,"lastInteractedAt":0}}}`)
	})
}

// 有序对象上限语义：situation visibility 的 64 项上限在「第 64 个合法
// 项之后」停止（Object.entries 顺序决定哪 64 个 key 存活）——用 66 个
// 交错合法/非法 key 验证存活集合与顺序无关的部分（合法项恰好前 64 个）。
func TestSituationVisibilityCapKeepsFirst64InOrder(t *testing.T) {
	raw := []byte(`{"visibility": {` +
		`"v001": true, "bad-key!": true, "v002": false, "": true, "v003": true,` +
		`"v004": true, "v005": true, "v006": true, "v007": true, "v008": true,` +
		`"v009": true, "v010": true, "v011": true, "v012": true, "v013": true,` +
		`"v014": true, "v015": true, "v016": true, "v017": true, "v018": true,` +
		`"v019": true, "v020": true, "v021": true, "v022": true, "v023": true,` +
		`"v024": true, "v025": true, "v026": true, "v027": true, "v028": true,` +
		`"v029": true, "v030": true, "v031": true, "v032": true, "v033": true,` +
		`"v034": true, "v035": true, "v036": true, "v037": true, "v038": true,` +
		`"v039": true, "v040": true, "v041": true, "v042": true, "v043": true,` +
		`"v044": true, "v045": true, "v046": true, "v047": true, "v048": true,` +
		`"v049": true, "v050": true, "v051": true, "v052": true, "v053": true,` +
		`"v054": true, "v055": true, "v056": true, "v057": true, "v058": true,` +
		`"v059": true, "v060": true, "v061": true, "v062": true, "v063": true,` +
		`"v064": true, "v065": true, "v066": true}}`)
	layout := NormalizeSituationLayout(raw)
	if len(layout.Visibility) != 64 {
		t.Fatalf("visibility = %d entries, want 64（上限即停止）", len(layout.Visibility))
	}
	if _, exists := layout.Visibility["v064"]; !exists {
		t.Error("v064 must survive (64th legal entry in order)")
	}
	if _, exists := layout.Visibility["v065"]; exists {
		t.Error("v065 must be dropped (past the 64-entry cap)")
	}
	if layout.Visibility["v002"] {
		t.Error("v002 = true, want false（原值保留）")
	}
}
