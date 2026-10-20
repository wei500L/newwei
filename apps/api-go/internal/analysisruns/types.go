// Package analysisruns owns the analysis product chain migrated by
// ANALYSIS-RUNS-001: the three request Mutations persist a pending
// analysisresults document and enqueue a BullMQ job, and the Go worker claims
// that job, runs the real statistical/geographic computation and the real
// streamed model call, writes the Mongo result, publishes the existing
// gqlsub:analysisEvents envelope and writes the MySQL notification.
//
// Organization ownership always comes from the persisted record. The job
// payload may carry orgId for compatibility with NestJS and for event routing;
// a present value must match the record, and a present type must match as well.
// The package never modifies another organization's document.
package analysisruns

// Type is one of the three persisted analysis types and BullMQ job names.
type Type string

const (
	TypeCorrelation  Type = "correlation"
	TypeAnomaly      Type = "anomaly"
	TypeGeoTransport Type = "geo_transport"
)

// Status is the persisted run status.
type Status string

const (
	StatusPending   Status = "pending"
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

// CorrelationInput is the persisted CorrelationAnalysisInput. This chain has no
// optional properties.
type CorrelationInput struct {
	IndicatorName string   `json:"indicatorName" bson:"indicatorName"`
	Value         float64  `json:"value" bson:"value"`
	ChangePercent float64  `json:"changePercent" bson:"changePercent"`
	StartDate     string   `json:"startDate" bson:"startDate"`
	EndDate       string   `json:"endDate" bson:"endDate"`
	NewsSummaries []string `json:"newsSummaries" bson:"newsSummaries"`
}

// SeriesPoint is one anomaly observation. The source DTO keeps the timestamp as
// a string; the detectors never parse it as a calendar date.
type SeriesPoint struct {
	Timestamp string  `json:"timestamp" bson:"timestamp"`
	Value     float64 `json:"value" bson:"value"`
}

// AnomalyInput is the persisted AnomalyAnalysisInput. Series is a pointer so an
// omitted property and an explicit null stay distinguishable in the document;
// the detectors treat both as an empty series.
type AnomalyInput struct {
	Metric           string         `json:"metric" bson:"metric"`
	Timestamp        string         `json:"timestamp" bson:"timestamp"`
	Value            float64        `json:"value" bson:"value"`
	DeviationPercent float64        `json:"deviationPercent" bson:"deviationPercent"`
	NewsList         []string       `json:"newsList" bson:"newsList"`
	PolicyList       []string       `json:"policyList" bson:"policyList"`
	Series           *[]SeriesPoint `json:"series,omitempty" bson:"series,omitempty"`
}

// GeoTransportInput is the persisted GeoTransportAnalysisInput. Bbox and
// objectKeys are omitted unless the resolver passed them through, matching the
// source `input.bbox?.length === 4` / non-empty objectKeys conditions.
type GeoTransportInput struct {
	TransportKinds []string  `json:"transportKinds" bson:"transportKinds"`
	StartDate      string    `json:"startDate" bson:"startDate"`
	EndDate        string    `json:"endDate" bson:"endDate"`
	Bbox           []float64 `json:"bbox,omitempty" bson:"bbox,omitempty"`
	ObjectKeys     []string  `json:"objectKeys,omitempty" bson:"objectKeys,omitempty"`
}

// StreamRaw is the output.raw value. model is omitted when no chunk carried a
// model name, matching JSON.stringify dropping undefined.
type StreamRaw struct {
	Stream bool    `json:"stream" bson:"stream"`
	Model  *string `json:"model,omitempty" bson:"model,omitempty"`
}

// CorrelationOutput is the persisted correlation output.
type CorrelationOutput struct {
	Summary string    `json:"summary" bson:"summary"`
	Raw     StreamRaw `json:"raw" bson:"raw"`
}

// AnomalyFinding is one statistical detector hit. The field order is the same
// as the NestJS object literal (point, reason, score).
type AnomalyFinding struct {
	Point  SeriesPoint `json:"point" bson:"point"`
	Reason string      `json:"reason" bson:"reason"`
	Score  float64     `json:"score" bson:"score"`
}

// AnomalyOutput is the persisted anomaly output.
type AnomalyOutput struct {
	Summary             string           `json:"summary" bson:"summary"`
	Raw                 StreamRaw        `json:"raw" bson:"raw"`
	StatisticalFindings []AnomalyFinding `json:"statisticalFindings" bson:"statisticalFindings"`
}

// GeoTransportOutput is the persisted geo output.
type GeoTransportOutput struct {
	Summary       string     `json:"summary" bson:"summary"`
	Raw           StreamRaw  `json:"raw" bson:"raw"`
	PromptVersion string     `json:"promptVersion" bson:"promptVersion"`
	Context       GeoContext `json:"context" bson:"context"`
}

// GeoFilters is the filters object of the geo context.
type GeoFilters struct {
	TransportKinds      []string  `json:"transportKinds" bson:"transportKinds"`
	StartDate           string    `json:"startDate" bson:"startDate"`
	EndDate             string    `json:"endDate" bson:"endDate"`
	Bbox                []float64 `json:"bbox,omitempty" bson:"bbox,omitempty"`
	RequestedObjectKeys []string  `json:"requestedObjectKeys,omitempty" bson:"requestedObjectKeys,omitempty"`
}

// GeoHotspot is one geo-cell count. Equal counts keep the original first-seen
// order because the source Array.sort is stable.
type GeoHotspot struct {
	GeoCell string `json:"geoCell" bson:"geoCell"`
	Count   int    `json:"count" bson:"count"`
}

// GeoPosition is the latest nullable position projection.
type GeoPosition struct {
	Lat        float64  `json:"lat" bson:"lat"`
	Lng        float64  `json:"lng" bson:"lng"`
	Heading    *float64 `json:"heading" bson:"heading"`
	Course     *float64 `json:"course" bson:"course"`
	Speed      *float64 `json:"speed" bson:"speed"`
	AltitudeFt *float64 `json:"altitudeFt" bson:"altitudeFt"`
}

// GeoTrackPoint is one of the latest 30 track points of an object.
type GeoTrackPoint struct {
	TrackPointID string   `json:"trackPointId" bson:"trackPointId"`
	ObservedAt   string   `json:"observedAt" bson:"observedAt"`
	Lat          float64  `json:"lat" bson:"lat"`
	Lng          float64  `json:"lng" bson:"lng"`
	Heading      *float64 `json:"heading" bson:"heading"`
	Course       *float64 `json:"course" bson:"course"`
	Speed        *float64 `json:"speed" bson:"speed"`
	AltitudeFt   *float64 `json:"altitudeFt" bson:"altitudeFt"`
	GeoCell      *string  `json:"geoCell" bson:"geoCell"`
}

// GeoObject is one observed object with its bounded track.
type GeoObject struct {
	ObjectKey         string          `json:"objectKey" bson:"objectKey"`
	EntityKind        string          `json:"entityKind" bson:"entityKind"`
	SourceScope       string          `json:"sourceScope" bson:"sourceScope"`
	Name              string          `json:"name" bson:"name"`
	DisplayCategory   *string         `json:"displayCategory" bson:"displayCategory"`
	DisplayCategoryZh *string         `json:"displayCategoryZh" bson:"displayCategoryZh"`
	Role              *string         `json:"role" bson:"role"`
	RoleZh            *string         `json:"roleZh" bson:"roleZh"`
	ShipTypeLabel     *string         `json:"shipTypeLabel" bson:"shipTypeLabel"`
	ShipTypeLabelZh   *string         `json:"shipTypeLabelZh" bson:"shipTypeLabelZh"`
	CountryCode       *string         `json:"countryCode" bson:"countryCode"`
	CountryName       *string         `json:"countryName" bson:"countryName"`
	LatestObservedAt  string          `json:"latestObservedAt" bson:"latestObservedAt"`
	LatestPosition    GeoPosition     `json:"latestPosition" bson:"latestPosition"`
	TrackPoints       []GeoTrackPoint `json:"trackPoints" bson:"trackPoints"`
}

// GeoContext is the complete structured context sent to the model. JSON field
// order matches the NestJS object literal; this matters because the prompt
// embeds JSON.stringify(context, null, 2) verbatim.
type GeoContext struct {
	Filters       GeoFilters   `json:"filters" bson:"filters"`
	ObjectKeys    []string     `json:"objectKeys" bson:"objectKeys"`
	TrackPointIDs []string     `json:"trackPointIds" bson:"trackPointIds"`
	Hotspots      []GeoHotspot `json:"hotspots" bson:"hotspots"`
	Objects       []GeoObject  `json:"objects" bson:"objects"`
}

// GeoPromptVersion is the fixed prompt contract version of the geo context.
const GeoPromptVersion = "geo-transport-v1"

// maxTrackPointsPerObject bounds the per-object track aggregation at the
// database, never after loading the full history into Go.
const maxTrackPointsPerObject = 30

// maxGeoObjects bounds the number of object states.
const maxGeoObjects = 20
