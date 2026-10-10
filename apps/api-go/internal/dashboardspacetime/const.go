package dashboardspacetime

import "time"

const (
	maxGeoRecords       = 2000
	maxGeoLocations     = 500
	maxGeoPoints        = 300
	maxGeoNetwork       = 6
	clusterStep         = 0.5
	heatHalfLifeDays    = 7
	snapshotTTL         = time.Hour
	dayMS               = int64(24 * time.Hour / time.Millisecond)
	defaultRangeDays    = 30
	geoArticleLimit     = 80
	geoArticleDefault   = 30
	propArticleLimit    = 100
	propArticleDefault  = 30
	propRowLimit        = 2000
	propWindowDefault   = 24
	propWindowMax       = 24 * 31
	propNodesDefault    = 140
	propNodesMin        = 30
	propNodesMax        = 600
	propEdgesDefault    = 320
	propEdgesMin        = 60
	propEdgesMax        = 2000
	propPredDefault     = 8
	propPredMax         = 24
	snapshotKeyPrefix   = "dashboard:spacetime:geo-heatmap:snapshot:"
	processedItemsName  = "processeditems"
	requiredPermission  = "dashboards.read"
)

const (
	// GeoPath 与 GeoArticlesPath 由 API_GO_DASHBOARD_SPACETIME_GEO_MODE 控制。
	GeoPath         = "/api/dashboard/spacetime/geo-heatmap"
	GeoArticlesPath = "/api/dashboard/spacetime/geo-heatmap/articles"
	// PropagationPath 与 PropagationArticlesPath 由另一个开关控制。
	PropagationPath         = "/api/dashboard/spacetime/propagation"
	PropagationArticlesPath = "/api/dashboard/spacetime/propagation/articles"
)

// GeoPaths 是热力图总览和下钻的精确路径。
var GeoPaths = []string{GeoPath, GeoArticlesPath}

// PropagationPaths 是传播图总览和下钻的精确路径。
var PropagationPaths = []string{PropagationPath, PropagationArticlesPath}
