package dashboardwarmap

var layerIDs = []string{
	"conflicts", "bases", "cables", "pipelines", "hotspots", "ais", "nuclear", "irradiators",
	"sanctions", "weather", "economic", "waterways", "outages", "cyberThreats", "datacenters",
	"protests", "flights", "military", "natural", "spaceports", "minerals", "fires", "ucdpEvents",
	"displacement", "climate", "startupHubs", "cloudRegions", "accelerators", "techHQs", "techEvents",
	"stockExchanges", "financialCenters", "centralBanks", "commodityHubs", "gulfInvestments",
	"positiveEvents", "kindness", "happiness", "speciesRecovery", "renewableInstallations",
	"tradeRoutes", "iranAttacks", "gpsJamming", "dayNight", "monitors",
}

var layerColors = map[string]string{
	"conflicts": "#ef4444", "bases": "#ec4899", "cables": "#8b5cf6", "pipelines": "#0ea5e9",
	"hotspots": "#f59e0b", "ais": "#2563eb", "nuclear": "#eab308", "irradiators": "#f97316",
	"sanctions": "#f43f5e", "weather": "#06b6d4", "economic": "#10b981", "waterways": "#0284c7",
	"outages": "#f97316", "cyberThreats": "#a855f7", "datacenters": "#6366f1", "protests": "#dc2626",
	"flights": "#2563eb", "military": "#b91c1c", "natural": "#16a34a", "spaceports": "#0f172a",
	"minerals": "#a16207", "fires": "#dc2626", "ucdpEvents": "#ef4444", "displacement": "#14b8a6",
	"climate": "#059669", "startupHubs": "#0ea5e9", "cloudRegions": "#6366f1", "accelerators": "#2563eb",
	"techHQs": "#1d4ed8", "techEvents": "#0284c7", "stockExchanges": "#0ea5e9", "financialCenters": "#1d4ed8",
	"centralBanks": "#1e3a8a", "commodityHubs": "#a16207", "gulfInvestments": "#0891b2",
	"positiveEvents": "#22c55e", "kindness": "#14b8a6", "happiness": "#10b981", "speciesRecovery": "#15803d",
	"renewableInstallations": "#16a34a", "tradeRoutes": "#0284c7", "iranAttacks": "#ef4444", "gpsJamming": "#f97316",
}

var layerKeywords = map[string][]string{
	"conflicts": {"war", "conflict", "battle", "invasion", "frontline"},
	"bases": {"base", "airbase", "garrison", "fleet", "command"},
	"cables": {"cable", "subsea", "fiber", "landing"},
	"pipelines": {"pipeline", "gas", "oil", "lpg", "lng"},
	"hotspots": {"crisis", "tension", "escalation", "urgent", "alert"},
	"ais": {"ship", "vessel", "shipping", "port", "maritime", "ais"},
	"nuclear": {"nuclear", "reactor", "uranium", "enrichment"},
	"irradiators": {"radiation", "irradiat", "isotope"},
	"sanctions": {"sanction", "export control", "embargo"},
	"weather": {"weather", "storm", "hurricane", "typhoon", "flood", "snow"},
	"economic": {"economy", "inflation", "gdp", "market", "rates"},
	"waterways": {"strait", "canal", "waterway", "chokepoint", "shipping lane"},
	"outages": {"outage", "blackout", "power cut", "grid failure"},
	"cyberThreats": {"cyber", "malware", "ddos", "ransomware", "hack"},
	"datacenters": {"datacenter", "data center", "server", "colo"},
	"protests": {"protest", "riot", "demonstration", "strike"},
	"flights": {"flight", "aviation", "airport", "airspace"},
	"military": {"military", "troop", "defense", "drill", "exercise"},
	"natural": {"earthquake", "volcano", "landslide", "natural disaster"},
	"spaceports": {"spaceport", "launch", "rocket", "orbital"},
	"minerals": {"lithium", "copper", "nickel", "cobalt", "rare earth"},
	"fires": {"fire", "wildfire", "burn"},
	"ucdpEvents": {"ucdp", "armed conflict", "fatality"},
	"displacement": {"refugee", "displacement", "evacuation", "idp"},
	"climate": {"climate", "emission", "heatwave", "drought", "co2"},
	"startupHubs": {"startup", "founder", "seed round", "venture"},
	"cloudRegions": {"cloud", "region", "availability zone"},
	"accelerators": {"accelerator", "incubator"},
	"techHQs": {"hq", "headquarters", "campus"},
	"techEvents": {"conference", "summit", "expo", "developer event"},
	"stockExchanges": {"exchange", "stock", "index"},
	"financialCenters": {"financial center", "banking hub"},
	"centralBanks": {"central bank", "rate decision", "monetary"},
	"commodityHubs": {"commodity", "trading hub", "futures"},
	"gulfInvestments": {"gulf", "sovereign fund", "pif", "adq"},
	"positiveEvents": {"ceasefire", "agreement", "breakthrough", "recovery"},
	"kindness": {"aid", "humanitarian", "rescue", "donation"},
	"happiness": {"happiness", "wellbeing", "quality of life"},
	"speciesRecovery": {"species", "wildlife", "recovery", "conservation"},
	"renewableInstallations": {"renewable", "solar", "wind", "battery", "hydro"},
	"tradeRoutes": {"trade route", "shipping route", "corridor"},
	"iranAttacks": {"iran", "tehran", "isfahan", "missile", "drone"},
	"gpsJamming": {"gps", "jamming", "spoofing", "navigation disruption"},
}

type namedPoint struct {
	ID, Name, Level, Description string
	Lat, Lng                     float64
}

type zonePoly struct {
	ID, Name, Color string
	Coords          [][2]float64
}

func staticLayers() map[string]any {
	stamp := layersStamp
	hotspots := []namedPoint{
		{"dc", "DC", "low", "Washington DC — US political center, White House, Pentagon, Capitol", 38.9, -77.0},
		{"moscow", "Moscow", "elevated", "Moscow — Kremlin, Russian military command, sanctions hub", 55.75, 37.6},
		{"beijing", "Beijing", "elevated", "Beijing — CCP headquarters, US-China tensions, tech rivalry", 39.9, 116.4},
		{"kyiv", "Kyiv", "high", "Kyiv — Active conflict zone, Russian invasion ongoing", 50.45, 30.5},
		{"taipei", "Taipei", "elevated", "Taipei — Taiwan Strait tensions, TSMC, China threat", 25.03, 121.5},
		{"tehran", "Tehran", "critical", "Tehran — Regime instability, regional escalation risk, nuclear program uncertainty", 35.7, 51.4},
		{"tel-aviv", "Tel Aviv", "high", "Tel Aviv — Israel-Gaza conflict, active military operations", 32.07, 34.78},
		{"london", "London", "low", "London — Financial center, Five Eyes, NATO ally", 51.5, -0.12},
		{"brussels", "Brussels", "low", "Brussels — EU/NATO headquarters, European policy", 50.85, 4.35},
		{"pyongyang", "Pyongyang", "elevated", "Pyongyang — North Korea nuclear threat, missile tests", 39.03, 125.75},
		{"riyadh", "Riyadh", "elevated", "Riyadh — Saudi oil, OPEC+, Yemen conflict, regional power", 24.7, 46.7},
		{"delhi", "Delhi", "low", "Delhi — India rising power, China border tensions", 28.6, 77.2},
		{"singapore", "Singapore", "low", "Singapore — Shipping chokepoint, Asian finance hub", 1.35, 103.82},
		{"tokyo", "Tokyo", "low", "Tokyo — US ally, regional security, economic power", 35.68, 139.76},
		{"caracas", "Caracas", "high", "Caracas — Venezuela crisis, sanctions, humanitarian emergency", 10.5, -66.9},
		{"nuuk", "Nuuk", "elevated", "Nuuk — Greenland, Arctic strategy, Denmark tensions", 64.18, -51.72},
	}
	zones := []zonePoly{
		{"ukraine", "Ukraine", "#ff4444", [][2]float64{{30, 52}, {40, 52}, {40, 45}, {30, 45}, {30, 52}}},
		{"gaza", "Gaza", "#ff4444", [][2]float64{{34, 32}, {35, 32}, {35, 31}, {34, 31}, {34, 32}}},
		{"taiwan-strait", "Taiwan Strait", "#ffaa00", [][2]float64{{117, 28}, {122, 28}, {122, 22}, {117, 22}, {117, 28}}},
		{"yemen", "Yemen", "#ff6644", [][2]float64{{42, 19}, {54, 19}, {54, 12}, {42, 12}, {42, 19}}},
		{"sudan", "Sudan", "#ff6644", [][2]float64{{22, 23}, {38, 23}, {38, 8}, {22, 8}, {22, 23}}},
		{"myanmar", "Myanmar", "#ff8844", [][2]float64{{92, 28}, {101, 28}, {101, 10}, {92, 10}, {92, 28}}},
	}
	chokes := []namedPoint{
		{"suez", "Suez", "", "Suez Canal — 12% of global trade, Europe-Asia route", 30.0, 32.5},
		{"panama", "Panama", "", "Panama Canal — Americas transit, Pacific-Atlantic link", 9.1, -79.7},
		{"hormuz", "Hormuz", "", "Strait of Hormuz — 21% of global oil, Persian Gulf exit", 26.5, 56.5},
		{"malacca", "Malacca", "", "Strait of Malacca — 25% of global trade, China supply line", 2.5, 101.0},
		{"bab-el-mandeb", "Bab el-M", "", "Bab el-Mandeb — Red Sea gateway, Houthi threat zone", 12.5, 43.3},
		{"gibraltar", "Gibraltar", "", "Strait of Gibraltar — Mediterranean access", 36.0, -5.5},
		{"bosporus", "Bosporus", "", "Bosporus Strait — Black Sea access, Russia exports", 41.1, 29.0},
	}
	cables := []namedPoint{
		{"nyc", "NYC", "", "New York — Transatlantic hub, 10+ cables", 40.7, -74.0},
		{"cornwall", "Cornwall", "", "Cornwall UK — Europe-Americas gateway", 50.1, -5.5},
		{"marseille", "Marseille", "", "Marseille — Mediterranean hub, SEA-ME-WE", 43.3, 5.4},
		{"mumbai", "Mumbai", "", "Mumbai — India gateway, 10+ cables", 19.1, 72.9},
		{"singapore-cable", "Singapore", "", "Singapore — Asia-Pacific nexus", 1.3, 103.8},
		{"hong-kong", "Hong Kong", "", "Hong Kong — China connectivity hub", 22.3, 114.2},
		{"tokyo-cable", "Tokyo", "", "Tokyo — Trans-Pacific terminus", 35.5, 139.8},
		{"sydney", "Sydney", "", "Sydney — Australia/Pacific hub", -33.9, 151.2},
		{"la", "LA", "", "Los Angeles — Pacific gateway", 33.7, -118.2},
		{"miami", "Miami", "", "Miami — Americas/Caribbean hub", 25.8, -80.2},
	}
	nuclear := []namedPoint{
		{"natanz", "Natanz", "", "Natanz — Iran uranium enrichment", 33.7, 51.7},
		{"yongbyon", "Yongbyon", "", "Yongbyon — North Korea nuclear complex", 39.8, 125.8},
		{"dimona", "Dimona", "", "Dimona — Israel nuclear facility", 31.0, 35.1},
		{"bushehr", "Bushehr", "", "Bushehr — Iran nuclear power plant", 28.8, 50.9},
		{"zaporizhzhia", "Zaporizhzhia", "", "Zaporizhzhia — Europe largest NPP, conflict zone", 47.5, 34.6},
		{"chernobyl", "Chernobyl", "", "Chernobyl — Exclusion zone, occupied 2022", 51.4, 30.1},
		{"fukushima", "Fukushima", "", "Fukushima — Decommissioning site", 37.4, 141.0},
	}
	bases := []namedPoint{
		{"ramstein", "Ramstein", "", "Ramstein — US Air Force, NATO hub Germany", 49.4, 7.6},
		{"diego-garcia", "Diego Garcia", "", "Diego Garcia — US/UK Indian Ocean base", -7.3, 72.4},
		{"okinawa", "Okinawa", "", "Okinawa — US Forces Japan, Pacific presence", 26.5, 127.9},
		{"guam", "Guam", "", "Guam — US Pacific Command, bomber base", 13.5, 144.8},
		{"djibouti", "Djibouti", "", "Djibouti — US/China/France bases, Horn of Africa", 11.5, 43.1},
		{"al-udeid", "Qatar", "", "Al Udeid — US CENTCOM forward HQ", 25.1, 51.3},
		{"kaliningrad", "Kaliningrad", "", "Kaliningrad — Russian Baltic exclave, missiles", 54.7, 20.5},
		{"sevastopol", "Sevastopol", "", "Sevastopol — Russian Black Sea Fleet", 44.6, 33.5},
		{"hainan", "Hainan", "", "Hainan — Chinese submarine base, South China Sea", 18.2, 109.5},
	}
	geometry := map[string]string{
		"conflicts": "polygon", "cables": "point", "pipelines": "path", "waterways": "point",
		"tradeRoutes": "path", "dayNight": "raster",
	}
	layers := map[string]any{}
	for _, id := range layerIDs {
		kind := geometry[id]
		if kind == "" {
			kind = "point"
		}
		layers[id] = map[string]any{
			"layerId": id, "geometryType": kind, "updatedAt": stamp,
			"renderHints": map[string]any{"pickable": true},
			"features":    []any{},
		}
	}
	hotspotRows := pointsPayload(hotspots, true)
	layers["hotspots"].(map[string]any)["features"] = pointFeatures(hotspots, "")
	layers["hotspots"].(map[string]any)["renderHints"] = map[string]any{"color": "#ffcc00", "radiusScale": 1.25, "pickable": true}
	layers["conflicts"].(map[string]any)["features"] = zoneFeatures(zones)
	layers["conflicts"].(map[string]any)["renderHints"] = map[string]any{"color": "#ff4444", "opacity": 0.18, "pickable": true}
	layers["waterways"].(map[string]any)["features"] = pointFeatures(chokes, "chokepoint")
	layers["cables"].(map[string]any)["features"] = pointFeatures(cables, "cableLanding")
	layers["nuclear"].(map[string]any)["features"] = pointFeatures(nuclear, "nuclearSite")
	layers["bases"].(map[string]any)["features"] = pointFeatures(bases, "militaryBase")
	return map[string]any{
		"updatedAt": stamp,
		"layers":    layers,
		"threatColors": map[string]any{
			"critical": "#ff0000", "high": "#ff4444", "elevated": "#ffcc00", "low": "#00ff88",
		},
		"hotspots":      hotspotRows,
		"conflictZones": zonePayload(zones),
		"chokepoints":   pointsPayload(chokes, false),
		"cableLandings": pointsPayload(cables, false),
		"nuclearSites":  pointsPayload(nuclear, false),
		"militaryBases": pointsPayload(bases, false),
	}
}

func pointsPayload(items []namedPoint, level bool) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		row := map[string]any{"id": item.ID, "name": item.Name, "lat": item.Lat, "lng": item.Lng, "description": item.Description}
		if level {
			row["level"] = item.Level
		}
		out = append(out, row)
	}
	return out
}

func zonePayload(items []zonePoly) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		coords := make([]any, 0, len(item.Coords))
		for _, coord := range item.Coords {
			coords = append(coords, []any{coord[0], coord[1]})
		}
		out = append(out, map[string]any{"id": item.ID, "name": item.Name, "coords": coords, "color": item.Color})
	}
	return out
}

func pointFeatures(items []namedPoint, category string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		props := map[string]any{"name": item.Name, "description": item.Description}
		if item.Level != "" {
			props["level"] = item.Level
		}
		if category != "" {
			props["category"] = category
		}
		out = append(out, map[string]any{"id": item.ID, "lat": item.Lat, "lng": item.Lng, "properties": props})
	}
	return out
}

func zoneFeatures(items []zonePoly) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		ring := make([]any, 0, len(item.Coords))
		for _, coord := range item.Coords {
			ring = append(ring, []any{coord[0], coord[1]})
		}
		out = append(out, map[string]any{
			"id":      item.ID,
			"polygon": []any{ring},
			"properties": map[string]any{
				"name": item.Name, "color": item.Color,
			},
		})
	}
	return out
}
