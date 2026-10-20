package classificationrssops

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Paths migrated by this switch. The 13 route rules live in
// internal/legacyproxy/classification_rss_ops_routes.go; these constants are the
// exact paths the handler dispatches on.
const (
	summaryPath             = "/api/admin/quality/classification/summary"
	reviewsQueuePath        = "/api/admin/quality/classification/reviews/queue"
	reviewsBatchPath        = "/api/admin/quality/classification/reviews/batch"
	samplingQueryPath       = "/api/admin/quality/classification/sampling/query"
	samplingAnnotationPath  = "/api/admin/quality/classification/sampling/annotations"
	sourcesPrefix           = "/api/admin/quality/classification/sources/"
	sourcesSuffix           = "/items"
	reviewsPrefix           = "/api/admin/quality/classification/reviews/"
	reviewsSuffix           = "/decision"
	reportsCreatePath       = "/api/admin/quality/classification/reports"
	reportsPrefix           = "/api/admin/quality/classification/reports/"
	diagnosticsOverviewPath = "/api/system-settings/rss-diagnostics/overview"
	diagnosticsChainPath    = "/api/system-settings/rss-diagnostics/chain"
	diagnosticsSourcesPath  = "/api/system-settings/rss-diagnostics/sources"
	diagnosticsBackfillPath = "/api/system-settings/rss-diagnostics/backfill-source-id"
	translationMetricsPath  = "/api/system-settings/rss-translation/metrics"

	// permissionManage matches @Permissions("settings.manage") on all 13 routes.
	permissionManage = "settings.manage"
)

// Handler serves only the routes taken over when the switch is go. Identity
// always comes from the authentication chain; no request parameter can supply
// an orgId.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the exact paths. The route table already guarantees one
// dynamic segment; the guards here keep a direct call from ever querying Mongo
// with a malformed id.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == summaryPath:
		h.serveSummary(w, r)
	case path == reviewsQueuePath:
		h.serveReviewQueue(w, r)
	case path == reviewsBatchPath:
		h.serveBatchReviewDecision(w, r)
	case path == samplingQueryPath:
		h.serveSamplingQuery(w, r)
	case path == samplingAnnotationPath:
		h.serveSamplingAnnotations(w, r)
	case path == diagnosticsOverviewPath:
		h.serveDiagnosticsOverview(w, r)
	case path == diagnosticsChainPath:
		h.serveDiagnosticsChain(w, r)
	case path == diagnosticsSourcesPath:
		h.serveDiagnosticsSources(w, r)
	case path == diagnosticsBackfillPath:
		h.serveBackfillSourceID(w, r)
	case path == translationMetricsPath:
		h.serveTranslationMetrics(w, r)
	case strings.HasPrefix(path, sourcesPrefix) && strings.HasSuffix(path, sourcesSuffix):
		segment, ok := singleSegment(path, sourcesPrefix, sourcesSuffix)
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveSourceItems(w, r, segment)
	case strings.HasPrefix(path, reviewsPrefix) && strings.HasSuffix(path, reviewsSuffix):
		segment, ok := singleSegment(path, reviewsPrefix, reviewsSuffix)
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveReviewDecision(w, r, segment)
	case path == reportsCreatePath:
		h.serveCreateReport(w, r)
	case strings.HasPrefix(path, reportsPrefix):
		segment := strings.TrimPrefix(path, reportsPrefix)
		if segment == "" || strings.Contains(segment, "/") {
			http.NotFound(w, r)
			return
		}
		h.serveReportJob(w, r, segment)
	default:
		http.NotFound(w, r)
	}
}

// singleSegment extracts the one dynamic segment between prefix and suffix.
func singleSegment(path, prefix, suffix string) (string, bool) {
	rest := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// authorize mirrors the authentication chain used by every migrated route:
// a missing Bearer token is 401, an mtk_ token goes through
// AuthenticateMachine, everything else through the JWT verifier plus the
// MySQL membership re-derivation, and a missing settings.manage is 403.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permissionManage) {
		authhttp.WriteForbidden(w, r, []string{permissionManage})
		return nil
	}
	return identity
}

// rawBearer extracts the Bearer token without any fallback.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// querySingleValue reads a query parameter that must appear exactly once.
func querySingleValue(r *http.Request, name string) string {
	return querySingle(r.URL.Query(), name)
}

// decodeJSONBody decodes the JSON body into a typed target. Content types other
// than JSON, and an empty body, are treated as an empty object.
func decodeJSONBody(r *http.Request, fill func([]byte) error) error {
	if r.Body == nil {
		return nil
	}
	contentType := r.Header.Get("Content-Type")
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "application/json" {
			return nil
		}
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return newStatus(400, "Invalid JSON body")
	}
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return nil
	}
	if err := fill([]byte(trimmed)); err != nil {
		return newStatus(400, "Invalid JSON body")
	}
	return nil
}

// stringArrayField mirrors the DTO transform that accepts either an array of
// strings or one comma-separated string, and remembers whether the key was
// present at all so @IsOptional keeps working.
type stringArrayField struct {
	Values  []string
	Present bool
}

// UnmarshalJSON implements the dual string/array shape.
func (f *stringArrayField) UnmarshalJSON(raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var values []string
		if err := json.Unmarshal(raw, &values); err != nil {
			return err
		}
		f.Values = values
		f.Present = true
		return nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		f.Values = strings.Split(value, ",")
		f.Present = true
		return nil
	}
	return fmt.Errorf("expected a string or an array of strings")
}

// ---- request bodies ----

// reviewDecisionBody mirrors ClassificationReviewDecisionBodyDto.
type reviewDecisionBody struct {
	Status                *string          `json:"status"`
	CorrectedCategoryPath *string          `json:"correctedCategoryPath"`
	Note                  *string          `json:"note"`
	QuickTags             stringArrayField `json:"quickTags"`
}

// batchReviewDecisionBody mirrors ClassificationBatchReviewDecisionBodyDto.
type batchReviewDecisionBody struct {
	Status                *string          `json:"status"`
	CorrectedCategoryPath *string          `json:"correctedCategoryPath"`
	Note                  *string          `json:"note"`
	QuickTags             stringArrayField `json:"quickTags"`
	ReviewIDs             stringArrayField `json:"reviewIds"`
}

// samplingQueryBody mirrors ClassificationSamplingQueryBodyDto.
type samplingQueryBody struct {
	Window          *string          `json:"window"`
	SourceType      *string          `json:"sourceType"`
	CategoryPrefix  *string          `json:"categoryPrefix"`
	SourceIDs       stringArrayField `json:"sourceIds"`
	ConfidenceBands stringArrayField `json:"confidenceBands"`
	Methods         stringArrayField `json:"methods"`
	PerStratum      *float64         `json:"perStratum"`
}

// samplingAnnotationEntryBody mirrors ClassificationSamplingAnnotationEntryDto.
type samplingAnnotationEntryBody struct {
	ProcessedItemID   *string          `json:"processedItemId"`
	HumanCategoryPath *string          `json:"humanCategoryPath"`
	Note              *string          `json:"note"`
	QuickTags         stringArrayField `json:"quickTags"`
}

// createReportBody mirrors ClassificationCreateReportBodyDto: sampleId is the
// only field and it is optional. The DTO transform drops non-string and blank
// values before @IsOptional runs, so they all mean "no sample filter".
type createReportBody struct {
	SampleID json.RawMessage `json:"sampleId"`
}

// samplingAnnotationsBody mirrors ClassificationSamplingAnnotationsBodyDto.
type samplingAnnotationsBody struct {
	SampleID    *string                        `json:"sampleId"`
	Annotations *[]samplingAnnotationEntryBody `json:"annotations"`
}

// backfillBody mirrors the controller's RssBackfillRequestBody.
type backfillBody struct {
	DryRun *bool    `json:"dryRun"`
	Limit  *float64 `json:"limit"`
}

// ---- handlers ----

func (h *Handler) serveSummary(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, err := parseQualityWindow(querySingleValue(r, "window"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, err := h.svc.ClassificationSummary(r.Context(), summaryRequest{
		OrgID:          identity.OrgID,
		Window:         window,
		SourceID:       parseOptionalStringQuery(querySingleValue(r, "sourceId")),
		CategoryPrefix: parseOptionalStringQuery(querySingleValue(r, "categoryPrefix")),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveSourceItems(w http.ResponseWriter, r *http.Request, sourceID string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, err := parseQualityWindow(querySingleValue(r, "window"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	maxConfidence, err := parseOptionalFloatQuery(querySingleValue(r, "maxConfidence"), "maxConfidence", 0, 1)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	limit, err := parseOptionalIntQuery(querySingleValue(r, "limit"), "limit", 1, sourceItemsLimitMax)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.LowConfidenceSourceItems(r.Context(), sourceItemsRequest{
		OrgID:         identity.OrgID,
		SourceID:      sourceID,
		Window:        window,
		MaxConfidence: maxConfidence,
		Limit:         limit,
		Cursor:        parseOptionalStringQuery(querySingleValue(r, "cursor")),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

func (h *Handler) serveReviewQueue(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, err := parseQualityWindow(querySingleValue(r, "window"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	onlyUnreviewed := true
	if value, present, err := parseOptionalBooleanQuery(querySingleValue(r, "onlyUnreviewed")); err != nil {
		writeServiceError(w, r, err)
		return
	} else if present {
		onlyUnreviewed = value
	}
	limit, err := parseOptionalIntQuery(querySingleValue(r, "limit"), "limit", 1, reviewQueueLimitMax)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	maxConfidence, err := parseOptionalFloatQuery(querySingleValue(r, "maxConfidence"), "maxConfidence", 0, 1)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	rows, err := h.svc.ListReviewQueue(r.Context(), reviewQueueRequest{
		OrgID:          identity.OrgID,
		Window:         window,
		OnlyUnreviewed: onlyUnreviewed,
		Limit:          limit,
		MaxConfidence:  maxConfidence,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

func (h *Handler) serveReviewDecision(w http.ResponseWriter, r *http.Request, reviewID string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body reviewDecisionBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	status, err := parseReviewDecisionStatus(body.Status)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	note, err := parseMaxLengthNote(body.Note)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	quickTags, err := parseQuickTags(body.QuickTags)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.SubmitReviewDecision(r.Context(), reviewDecisionRequest{
		OrgID:                 identity.OrgID,
		ActorID:               identity.UserID,
		ReviewID:              reviewID,
		Status:                status,
		CorrectedCategoryPath: body.CorrectedCategoryPath,
		Note:                  note,
		QuickTags:             quickTags,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveBatchReviewDecision(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body batchReviewDecisionBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	status, err := parseReviewDecisionStatus(body.Status)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if !body.ReviewIDs.Present || len(body.ReviewIDs.Values) == 0 {
		writeServiceError(w, r, newStatus(400, "reviewIds must be an array"))
		return
	}
	reviewIDs := normalizeStringArray(body.ReviewIDs.Values, maxReviewBatchIDs)
	if len(reviewIDs) == 0 {
		writeServiceError(w, r, newStatus(400, "reviewIds must contain at least 1 elements"))
		return
	}
	note, err := parseMaxLengthNote(body.Note)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	quickTags, err := parseQuickTags(body.QuickTags)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.BatchReviewDecision(r.Context(), batchReviewDecisionRequest{
		OrgID:                 identity.OrgID,
		ActorID:               identity.UserID,
		ReviewIDs:             reviewIDs,
		Status:                status,
		CorrectedCategoryPath: body.CorrectedCategoryPath,
		Note:                  note,
		QuickTags:             quickTags,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveSamplingQuery(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body samplingQueryBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	window := QualityWindow24h
	if body.Window != nil {
		parsed, err := parseQualityWindow(*body.Window)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		window = parsed
	}
	var sourceType *ClassifiedSourceType
	if body.SourceType != nil {
		normalized := strings.ToLower(strings.TrimSpace(*body.SourceType))
		switch ClassifiedSourceType(normalized) {
		case ClassifiedSourceAuthoritative, ClassifiedSourceBlog, ClassifiedSourceUnknown:
			value := ClassifiedSourceType(normalized)
			sourceType = &value
		default:
			writeServiceError(w, r, newStatus(400,
				"sourceType must be one of the following values: authoritative, blog, unknown"))
			return
		}
	}
	confidenceBands, err := parseConfidenceBands(body.ConfidenceBands)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	perStratum, err := parseOptionalIntFromJSON(body.PerStratum, "perStratum", 1, 200)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.CreateSample(r.Context(), samplingRequest{
		OrgID:           identity.OrgID,
		ActorID:         identity.UserID,
		Window:          window,
		SourceType:      sourceType,
		CategoryPrefix:  body.CategoryPrefix,
		SourceIDs:       optionalStringArray(body.SourceIDs, 300),
		ConfidenceBands: confidenceBands,
		Methods:         optionalStringArray(body.Methods, 100),
		PerStratum:      perStratum,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveSamplingAnnotations(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body samplingAnnotationsBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	sampleID := ""
	if body.SampleID != nil {
		sampleID = strings.TrimSpace(*body.SampleID)
	}
	if sampleID == "" {
		writeServiceError(w, r, newStatus(400, "sampleId must be a string"))
		return
	}
	entries := []samplingAnnotationEntryBody{}
	if body.Annotations != nil {
		entries = *body.Annotations
	}
	if len(entries) == 0 {
		writeServiceError(w, r, newStatus(400, "annotations must contain at least 1 elements"))
		return
	}
	if len(entries) > 1000 {
		writeServiceError(w, r, newStatus(400, "annotations must contain no more than 1000 elements"))
		return
	}
	annotations := make([]annotationEntry, 0, len(entries))
	for _, entry := range entries {
		processedItemID := ""
		if entry.ProcessedItemID != nil {
			processedItemID = strings.TrimSpace(*entry.ProcessedItemID)
		}
		if processedItemID == "" {
			writeServiceError(w, r, newStatus(400, "processedItemId must be a string"))
			return
		}
		humanCategoryPath := ""
		if entry.HumanCategoryPath != nil {
			humanCategoryPath = strings.TrimSpace(*entry.HumanCategoryPath)
		}
		if humanCategoryPath == "" {
			writeServiceError(w, r, newStatus(400, "humanCategoryPath must be a string"))
			return
		}
		note, err := parseMaxLengthNote(entry.Note)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		quickTags, err := parseQuickTags(entry.QuickTags)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		annotations = append(annotations, annotationEntry{
			ProcessedItemID:   processedItemID,
			HumanCategoryPath: humanCategoryPath,
			Note:              note,
			QuickTags:         quickTags,
		})
	}
	response, err := h.svc.SubmitAnnotations(r.Context(), annotationsRequest{
		OrgID:       identity.OrgID,
		ActorID:     identity.UserID,
		SampleID:    sampleID,
		Annotations: annotations,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveCreateReport(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body createReportBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	var sampleID *string
	if trimmed := payloadString(body.SampleID); trimmed != "" {
		sampleID = &trimmed
	}
	response, err := h.svc.CreateReportJob(r.Context(), createReportJobRequest{
		OrgID:    identity.OrgID,
		ActorID:  identity.UserID,
		SampleID: sampleID,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveReportJob(w http.ResponseWriter, r *http.Request, jobID string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	response, err := h.svc.GetReportJob(r.Context(), reportJobRequest{OrgID: identity.OrgID, JobID: jobID})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if response == nil {
		writeJSON(w, http.StatusOK, json.RawMessage("null"))
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

func (h *Handler) serveDiagnosticsOverview(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, err := parseDiagnosticsQuery(r, identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, err := h.svc.RSSDiagnosticsOverview(r.Context(), query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDiagnosticsChain(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, err := parseDiagnosticsQuery(r, identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, err := h.svc.RSSDiagnosticsChain(r.Context(), query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDiagnosticsSources(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, err := parseDiagnosticsQuery(r, identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, err := h.svc.RSSDiagnosticsSources(r.Context(), query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveBackfillSourceID(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body backfillBody
	if err := decodeJSONBody(r, func(raw []byte) error { return json.Unmarshal(raw, &body) }); err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.BackfillSourceID(r.Context(), rssBackfillRequest{
		OrgID:  identity.OrgID,
		DryRun: body.DryRun,
		Limit:  body.Limit,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

func (h *Handler) serveTranslationMetrics(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(querySingleValue(r, "provider")))
	if provider != "" && provider != "deeplx" && provider != "llm" {
		writeServiceError(w, r, newStatus(400, "provider must be one of: deeplx, llm"))
		return
	}
	var providerFilter *string
	if provider != "" {
		value := provider
		providerFilter = &value
	}
	response, err := h.svc.RSSTranslationMetrics(r.Context(), translationMetricsQuery{
		OrgID:          identity.OrgID,
		From:           parseOptionalStringQuery(querySingleValue(r, "from")),
		To:             parseOptionalStringQuery(querySingleValue(r, "to")),
		Provider:       providerFilter,
		TargetLanguage: parseOptionalStringQuery(querySingleValue(r, "targetLanguage")),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

// parseDiagnosticsQuery mirrors the controller's Number(raw) parse plus the
// service clamps.
func parseDiagnosticsQuery(r *http.Request, orgID string) (rssDiagnosticsQuery, error) {
	query := rssDiagnosticsQuery{OrgID: orgID}
	if value, ok := finiteNumber(querySingleValue(r, "windowDays")); ok {
		query.WindowDays = &value
	}
	if value, ok := finiteNumber(querySingleValue(r, "lookbackHours")); ok {
		query.LookbackHours = &value
	}
	return query, nil
}

// parseReviewDecisionStatus validates the required status enum.
func parseReviewDecisionStatus(raw *string) (ReviewDecisionStatus, error) {
	message := "status must be one of the following values: approved, rejected, corrected"
	if raw == nil {
		return "", newStatus(400, message)
	}
	normalized := strings.TrimSpace(*raw)
	switch ReviewDecisionStatus(normalized) {
	case ReviewDecisionApproved, ReviewDecisionRejected, ReviewDecisionCorrected:
		return ReviewDecisionStatus(normalized), nil
	}
	return "", newStatus(400, message)
}

// parseMaxLengthNote mirrors @IsOptional @IsString @MaxLength(500) after the
// normalizeOptionalString transform.
func parseMaxLengthNote(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	if utf16Length(trimmed) > 500 {
		return nil, newStatus(400, "note must be shorter than or equal to 500 characters")
	}
	value := trimmed
	return &value, nil
}

// parseQuickTags mirrors normalizeStringArray(value, 20) plus
// @MaxLength(60, { each: true }).
func parseQuickTags(raw stringArrayField) ([]string, error) {
	if !raw.Present {
		return nil, nil
	}
	tags := normalizeStringArray(raw.Values, 20)
	for _, tag := range tags {
		if utf16Length(tag) > 60 {
			return nil, newStatus(400, "each value in quickTags must be shorter than or equal to 60 characters")
		}
	}
	return tags, nil
}

// parseConfidenceBands mirrors @IsIn(CONFIDENCE_BANDS, { each: true }).
func parseConfidenceBands(raw stringArrayField) ([]ConfidenceBand, error) {
	if !raw.Present {
		return nil, nil
	}
	values := normalizeStringArray(raw.Values, 10)
	out := make([]ConfidenceBand, 0, len(values))
	for _, value := range values {
		switch ConfidenceBand(value) {
		case ConfidenceBandLow, ConfidenceBandMedium, ConfidenceBandHigh:
			out = append(out, ConfidenceBand(value))
		default:
			return nil, newStatus(400,
				"each value in confidenceBands must be one of the following values: low, medium, high")
		}
	}
	return out, nil
}

// parseOptionalIntFromJSON validates an already-parsed JSON number the way
// normalizeOptionalInteger plus @IsInt/@Min/@Max would.
func parseOptionalIntFromJSON(raw *float64, name string, min, max int) (*int, error) {
	if raw == nil {
		return nil, nil
	}
	if isNotFiniteValue(*raw) {
		return nil, nil
	}
	floored := int(floorValue(*raw))
	if floored < min {
		return nil, newStatus(400, name+" must not be less than "+itoa(min))
	}
	if floored > max {
		return nil, newStatus(400, name+" must not be greater than "+itoa(max))
	}
	return &floored, nil
}

// optionalStringArray normalizes an optional string-array field.
func optionalStringArray(raw stringArrayField, maxSize int) []string {
	if !raw.Present {
		return nil
	}
	return normalizeStringArray(raw.Values, maxSize)
}

// normalizeStringArray mirrors normalizeStringArray(value, maxSize): entries are
// trimmed, deduplicated and capped. The comma-splitting already happened while
// decoding stringArrayField.
func normalizeStringArray(values []string, maxSize int) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, entry := range values {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
		if len(out) >= maxSize {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// writeJSON writes a pre-encoded JSON payload with the NestJS content type.
func writeJSON(w http.ResponseWriter, status int, payload json.RawMessage) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// writeServiceError maps a typed service error onto the GlobalExceptionFilter
// response shape, reusing the adminlogs mapping for machine-token errors.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if status, message, ok := statusOf(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	if status, message, ok := adminlogs.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	log.Printf("classification rss ops: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

// isNotFiniteValue reports NaN or an infinity for JSON numbers.
func isNotFiniteValue(value float64) bool {
	return value != value
}

// floorValue truncates toward negative infinity.
func floorValue(value float64) float64 {
	truncated := float64(int64(value))
	if value < 0 && truncated != value {
		return truncated - 1
	}
	return truncated
}
