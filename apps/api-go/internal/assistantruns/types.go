package assistantruns

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// RunType is the AssistantRun.type enum.
type RunType string

const (
	RunTypeQuery    RunType = "query"
	RunTypeReport   RunType = "report"
	RunTypeForecast RunType = "forecast"
)

// RunStatus is the AssistantRun.status enum.
type RunStatus string

const (
	RunStatusPending   RunStatus = "pending"
	RunStatusRunning   RunStatus = "running"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
)

// KnowledgeSource is AssistantKnowledgeSource.
type KnowledgeSource string

const (
	KnowledgeSourceSiteDB    KnowledgeSource = "site_db"
	KnowledgeSourceWebSearch KnowledgeSource = "web_search"
)

// QueryInput is the stored AssistantRun.input for a query run.
type QueryInput struct {
	Message         string          `json:"message" bson:"message"`
	ConversationID  string          `json:"conversationId" bson:"conversationId"`
	KnowledgeSource KnowledgeSource `json:"knowledgeSource" bson:"knowledgeSource"`
}

// ReportInput is the stored AssistantRun.input for a report run.
type ReportInput struct {
	Period string  `json:"period" bson:"period"`
	Topic  *string `json:"topic,omitempty" bson:"topic,omitempty"`
	Limit  *int    `json:"limit,omitempty" bson:"limit,omitempty"`
}

// ForecastInput is the stored AssistantRun.input for a forecast run.
type ForecastInput struct {
	Series          string   `json:"series" bson:"series"`
	LookbackDays    *int     `json:"lookbackDays,omitempty" bson:"lookbackDays,omitempty"`
	SourceField     *string  `json:"sourceField,omitempty" bson:"sourceField,omitempty"`
	SeasonalPeriod  *int     `json:"seasonalPeriod,omitempty" bson:"seasonalPeriod,omitempty"`
	ModelKind       *string  `json:"modelKind,omitempty" bson:"modelKind,omitempty"`
	ConfidenceLevel *float64 `json:"confidenceLevel,omitempty" bson:"confidenceLevel,omitempty"`
}

// TimeWindow is the {startDate,endDate} object shared by the outputs.
type TimeWindow struct {
	StartDate string `json:"startDate" bson:"startDate"`
	EndDate   string `json:"endDate" bson:"endDate"`
}

// StreamRaw is the output.raw object. model stays absent when the gateway did
// not report one, matching JSON.stringify(undefined).
type StreamRaw struct {
	Stream bool    `json:"stream" bson:"stream"`
	Model  *string `json:"model,omitempty" bson:"model,omitempty"`
}

// RenderedItem is one renderNewsItems row. Every field is emitted (null when
// absent), exactly like the NestJS object literal.
type RenderedItem struct {
	ItemMetaID  string  `json:"itemMetaId" bson:"itemMetaId"`
	Title       *string `json:"title" bson:"title"`
	Summary     *string `json:"summary" bson:"summary"`
	Source      *string `json:"source" bson:"source"`
	PublishedAt *string `json:"publishedAt" bson:"publishedAt"`
	URL         *string `json:"url" bson:"url"`
	Sentiment   *string `json:"sentiment" bson:"sentiment"`
}

// NewsListPlan is the parsed news_negative_list plan.
type NewsListPlan struct {
	Kind         string `json:"kind" bson:"kind"`
	Topic        string `json:"topic" bson:"topic"`
	LookbackDays *int   `json:"lookbackDays,omitempty" bson:"lookbackDays,omitempty"`
	Limit        *int   `json:"limit,omitempty" bson:"limit,omitempty"`
}

// UnsupportedPlan is the {kind:"unsupported"[,"reason"]} plan.
type UnsupportedPlan struct {
	Kind   string  `json:"kind" bson:"kind"`
	Reason *string `json:"reason,omitempty" bson:"reason,omitempty"`
}

// CorrelationPlanSeries is the {input,slug,field} triple of the rendered
// correlation plan.
type CorrelationPlanSeries struct {
	Input string `json:"input" bson:"input"`
	Slug  string `json:"slug" bson:"slug"`
	Field string `json:"field" bson:"field"`
}

// CorrelationQueryPlan is the plan object stored by runCorrelationQuery.
type CorrelationQueryPlan struct {
	Kind         string                `json:"kind" bson:"kind"`
	Transform    string                `json:"transform" bson:"transform"`
	LookbackDays int                   `json:"lookbackDays" bson:"lookbackDays"`
	SeriesA      CorrelationPlanSeries `json:"seriesA" bson:"seriesA"`
	SeriesB      CorrelationPlanSeries `json:"seriesB" bson:"seriesB"`
}

// ResolvedFrom records how an economic series was resolved.
type ResolvedFrom struct {
	Input  string `json:"input" bson:"input"`
	Method string `json:"method" bson:"method"`
}

// SeriesReference is the economic series metadata in the correlation and
// forecast outputs.
type SeriesReference struct {
	Slug         string       `json:"slug" bson:"slug"`
	DisplayName  string       `json:"displayName" bson:"displayName"`
	DocURL       *string      `json:"docUrl" bson:"docUrl"`
	SourceField  string       `json:"sourceField" bson:"sourceField"`
	ResolvedFrom ResolvedFrom `json:"resolvedFrom" bson:"resolvedFrom"`
}

// CorrelationStats is {n,pearson} where pearson is null when undefined.
type CorrelationStats struct {
	N       int      `json:"n" bson:"n"`
	Pearson *float64 `json:"pearson" bson:"pearson"`
}

// QueryNewsOutput is the query output of the news_negative_list branch.
type QueryNewsOutput struct {
	Plan    NewsListPlan   `json:"plan" bson:"plan"`
	Items   []RenderedItem `json:"items" bson:"items"`
	Summary string         `json:"summary" bson:"summary"`
	Raw     StreamRaw      `json:"raw" bson:"raw"`
}

// QueryCorrelationOutput is the query output of the two correlation branches.
type QueryCorrelationOutput struct {
	Plan       CorrelationQueryPlan `json:"plan" bson:"plan"`
	References []SeriesReference    `json:"references" bson:"references"`
	Stats      CorrelationStats     `json:"stats" bson:"stats"`
	Summary    string               `json:"summary" bson:"summary"`
	Raw        StreamRaw            `json:"raw" bson:"raw"`
}

// QueryUnsupportedOutput is the query output of the unsupported branch.
type QueryUnsupportedOutput struct {
	Plan    UnsupportedPlan `json:"plan" bson:"plan"`
	Summary string          `json:"summary" bson:"summary"`
	Raw     StreamRaw       `json:"raw" bson:"raw"`
}

// QueryWebSearchOutput is the query output of the web_search branch.
type QueryWebSearchOutput struct {
	KnowledgeSource string    `json:"knowledgeSource" bson:"knowledgeSource"`
	Summary         string    `json:"summary" bson:"summary"`
	Raw             StreamRaw `json:"raw" bson:"raw"`
}

// SentimentCounts is the per-sentiment count map of the report output. The
// keys are data-driven (any sentiment label can occur), so a named map is the
// only faithful projection of the NestJS reduce.
type SentimentCounts map[string]int

// ReportOutput is the report run output.
type ReportOutput struct {
	Period     string          `json:"period" bson:"period"`
	Topic      *string         `json:"topic" bson:"topic"`
	TimeWindow TimeWindow      `json:"timeWindow" bson:"timeWindow"`
	Stats      SentimentCounts `json:"stats" bson:"stats"`
	Items      []RenderedItem  `json:"items" bson:"items"`
	Summary    string          `json:"summary" bson:"summary"`
	Raw        StreamRaw       `json:"raw" bson:"raw"`
}

// ForecastSeries is the output.series object.
type ForecastSeries struct {
	Slug        string  `json:"slug" bson:"slug"`
	DisplayName string  `json:"displayName" bson:"displayName"`
	Field       string  `json:"field" bson:"field"`
	DocURL      *string `json:"docUrl" bson:"docUrl"`
}

// ForecastPoint is one model-service forecast interval.
type ForecastPoint struct {
	Timestamp string  `json:"timestamp" bson:"timestamp"`
	Expected  float64 `json:"expected" bson:"expected"`
	Lower     float64 `json:"lower" bson:"lower"`
	Upper     float64 `json:"upper" bson:"upper"`
	Sigma     float64 `json:"sigma" bson:"sigma"`
}

// SeriesPoint is one {timestamp,value} point; actual uses it too.
type SeriesPoint struct {
	Timestamp string  `json:"timestamp" bson:"timestamp"`
	Value     float64 `json:"value" bson:"value"`
}

// ForecastErrors is the holdout-last error triple.
type ForecastErrors struct {
	Error    float64  `json:"error" bson:"error"`
	AbsError float64  `json:"absError" bson:"absError"`
	PctError *float64 `json:"pctError" bson:"pctError"`
}

// JSONValue is an external JSON object stored verbatim in both MongoDB and the
// GraphQL JSON scalar. json.RawMessage alone would be stored as a BSON binary
// blob, so the BSON marshaler converts it back to a document.
type JSONValue json.RawMessage

// MarshalJSON emits the original JSON.
func (v JSONValue) MarshalJSON() ([]byte, error) {
	if len(v) == 0 {
		return []byte("null"), nil
	}
	return []byte(v), nil
}

// MarshalBSON stores the JSON as a BSON document, not a binary value.
func (v JSONValue) MarshalBSON() ([]byte, error) {
	if len(v) == 0 {
		return bson.Marshal(bson.D{})
	}
	var document bson.D
	if err := bson.UnmarshalExtJSON([]byte(v), false, &document); err != nil {
		return nil, err
	}
	return bson.Marshal(document)
}

// UnmarshalJSON keeps the original JSON.
func (v *JSONValue) UnmarshalJSON(data []byte) error {
	*v = append((*v)[:0], data...)
	return nil
}

// UnmarshalBSON converts an embedded BSON document back to JSON. The document
// holds only plain JSON values (model metadata and diagnostics), so decoding it
// into the BSON map codec and re-encoding as JSON preserves the leaf.
func (v *JSONValue) UnmarshalBSON(data []byte) error {
	var document bson.M
	if err := bson.Unmarshal(data, &document); err != nil {
		return err
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	*v = append((*v)[:0], encoded...)
	return nil
}

// ForecastOutput is the forecast run output.
type ForecastOutput struct {
	Series           ForecastSeries    `json:"series" bson:"series"`
	TimeWindow       TimeWindow        `json:"timeWindow" bson:"timeWindow"`
	ModelServiceUsed bool              `json:"modelServiceUsed" bson:"modelServiceUsed"`
	Model            JSONValue         `json:"model" bson:"model"`
	Forecast         ForecastPoint     `json:"forecast" bson:"forecast"`
	Actual           SeriesPoint       `json:"actual" bson:"actual"`
	Errors           ForecastErrors    `json:"errors" bson:"errors"`
	Diagnostics      JSONValue         `json:"diagnostics" bson:"diagnostics"`
	References       []SeriesReference `json:"references" bson:"references"`
	Summary          string            `json:"summary" bson:"summary"`
	Raw              StreamRaw         `json:"raw" bson:"raw"`
}

// BlockedOutput is the output written when a guardrail refused the request.
type BlockedOutput struct {
	Blocked           bool     `json:"blocked" bson:"blocked"`
	Code              string   `json:"code" bson:"code"`
	Summary           string   `json:"summary" bson:"summary"`
	AppliedGuardrails []string `json:"appliedGuardrails" bson:"appliedGuardrails"`
	UpstreamStatus    *int     `json:"upstreamStatus" bson:"upstreamStatus"`
}

// AssistantEvent is the subscription payload published on assistantEvents.
// Field order is the NestJS object literal order, so the Redis message is
// byte-identical to GraphqlSubscriptionBus publication.
type AssistantEvent struct {
	OrgID string          `json:"orgId"`
	Run   AssistantRunRef `json:"run"`
}

// AssistantRunRef is the run summary carried by an assistant event.
type AssistantRunRef struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Status    string  `json:"status"`
	Summary   *string `json:"summary,omitempty"`
	Error     *string `json:"error,omitempty"`
	CreatedAt string  `json:"createdAt"`
}

// SubmittedRun is the projection the three submit mutations return. The typed
// input object, output and error are attached by the GraphQL write layer.
type SubmittedRun struct {
	ID             string
	Type           RunType
	Status         RunStatus
	ConversationID *string
	CreatedAt      time.Time
}

// Failure is the typed business failure the write layer maps onto the GraphQL
// failure contract. The messages are the NestJS ones.
type Failure struct {
	Status  int
	Code    string
	Message string
}

func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

func failure(status int, message string) *Failure {
	return &Failure{Status: status, Message: message}
}

// assistantStreamError carries the partial summary of an interrupted stream.
type assistantStreamError struct {
	Message        string
	PartialSummary string
}

func (e *assistantStreamError) Error() string { return e.Message }

// compile-time assertion that Failure implements error.
var _ error = (*Failure)(nil)
