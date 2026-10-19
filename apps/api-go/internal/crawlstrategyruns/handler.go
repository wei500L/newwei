package crawlstrategyruns

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file serves the three crawl discovery entries. Both switches are separate
// but share one handler key, so the dispatcher below matches the exact paths the
// route file registers:
//
//	GET  /api/admin/news-sources/:id/preview
//	POST /api/admin/crawl-frontier/workflows/:id/trial-run
//	POST /api/admin/crawl-frontier/workflow-runs/:runId/replay
//
// The organization comes only from the authenticated identity; no body or path
// value can select the tenant.

const (
	newsSourcesPath     = "/api/admin/news-sources"
	frontierBasePath    = "/api/admin/crawl-frontier"
	maxRequestBodySize  = 10 << 20
	permissionCrawlRead = "crawl.read"
)

// machineAuthenticator is the `mtk_` machine-token chain shared with the other
// crawl entries.
type machineAuthenticator interface {
	AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error)
}

// Handler serves the three entries. Preview may be nil when only the trial/replay
// switch is go and runs may be nil when only the preview switch is go; the route
// rules guarantee the disabled path never reaches this handler.
type Handler struct {
	auth    *authhttp.Authenticator
	runs    *Service
	preview *crawlmetadata.PreviewService
	machine machineAuthenticator
}

// NewHandler builds the handler.
func NewHandler(auth *authhttp.Authenticator, runs *Service, preview *crawlmetadata.PreviewService, machine machineAuthenticator) *Handler {
	return &Handler{auth: auth, runs: runs, preview: preview, machine: machine}
}

// ServeHTTP dispatches the three exact routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && strings.HasPrefix(path, newsSourcesPath+"/") && strings.HasSuffix(path, "/preview"):
		sourceID, ok := singleSegment(strings.TrimSuffix(path, "/preview"), newsSourcesPath+"/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.servePreview(w, r, sourceID)
	case r.Method == http.MethodPost && strings.HasPrefix(path, frontierBasePath+"/workflows/") && strings.HasSuffix(path, "/trial-run"):
		workflowID, ok := singleSegment(strings.TrimSuffix(path, "/trial-run"), frontierBasePath+"/workflows/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveTrialRun(w, r, workflowID)
	case r.Method == http.MethodPost && strings.HasPrefix(path, frontierBasePath+"/workflow-runs/") && strings.HasSuffix(path, "/replay"):
		runID, ok := singleSegment(strings.TrimSuffix(path, "/replay"), frontierBasePath+"/workflow-runs/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveReplay(w, r, runID)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) servePreview(w http.ResponseWriter, r *http.Request, sourceID string) {
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	if h.preview == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	document, err := h.preview.Preview(r.Context(), identity.OrgID, sourceID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, document)
}

func (h *Handler) serveTrialRun(w http.ResponseWriter, r *http.Request, workflowID string) {
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	input, err := validateTrialRun(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if h.runs == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	response, err := h.runs.TrialRun(r.Context(), identity.OrgID, identity.UserID, workflowID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS' POST default is 201; trialRun has no @HttpCode override.
	writeJSON(w, http.StatusCreated, response)
}

func (h *Handler) serveReplay(w http.ResponseWriter, r *http.Request, runID string) {
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	input, err := validateReplay(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if h.runs == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	response, err := h.runs.Replay(r.Context(), identity.OrgID, identity.UserID, runID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

// authorize runs the shared authentication chain and enforces crawl.read.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		if h.machine == nil {
			authhttp.WriteUnauthorized(w, r, "Invalid machine token")
			return nil
		}
		resolved, err := h.machine.AuthenticateMachine(r.Context(), raw)
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// singleSegment requires exactly one non-empty path segment after prefix.
func singleSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// readJSONBody mirrors the crawl workflow body handling: an absent/non-JSON body
// is `{}`, invalid JSON is the framework 400, an oversized body is 413.
func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContent(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	limited := http.MaxBytesReader(nil, r.Body, maxRequestBodySize)
	defer func() { _ = limited.Close() }()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(data) {
		authhttp.WriteBadRequest(w, r, "Expected property name or '}' in JSON at position 1")
		return nil, false
	}
	return data, true
}

func jsonContent(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}

// ---- DTO validation ----

// trialRunFields is the TrialRunCrawlStrategyWorkflowDto property list.
var trialRunFields = map[string]bool{
	"workflowVersionId": true,
	"profileId":         true,
	"newsSourceId":      true,
	"seedUrl":           true,
	"runKind":           true,
	"maxCandidates":     true,
	"runtimeOverrides":  true,
}

// replayFields is the ReplayCrawlStrategyWorkflowRunDto property list.
var replayFields = map[string]bool{
	"seedUrl":       true,
	"profileId":     true,
	"newsSourceId":  true,
	"maxCandidates": true,
}

// trialRunKinds is WORKFLOW_RUN_KINDS (frontier_run is not accepted).
var trialRunKinds = []string{RunKindTrial, RunKindProfilePreview, RunKindNewsSourcePreview, RunKindFrontierCompile}

func validateTrialRun(body []byte) (TrialRunInput, error) {
	fields, err := parseFields(body)
	if err != nil {
		return TrialRunInput{}, err
	}
	if err := rejectUnknown(fields, trialRunFields); err != nil {
		return TrialRunInput{}, err
	}
	var input TrialRunInput
	messages := []string{}
	input.WorkflowVersionID = optionalIdentifier(fields, "workflowVersionId", &messages)
	input.ProfileID = optionalIdentifier(fields, "profileId", &messages)
	input.NewsSourceID = optionalIdentifier(fields, "newsSourceId", &messages)
	if raw, ok := fields["seedUrl"]; ok {
		text, isString := jsonString(raw)
		if !isString || !isAbsoluteHTTPURL(text) {
			messages = append(messages, "seedUrl must be a URL address")
		} else {
			input.SeedURL = &text
		}
	}
	if raw, ok := fields["runKind"]; ok {
		text, isString := jsonString(raw)
		if !isString || !containsString(trialRunKinds, text) {
			messages = append(messages, "runKind must be one of the following values: "+strings.Join(trialRunKinds, ", "))
		} else {
			input.RunKind = &text
		}
	}
	input.MaxCandidates = optionalMaxCandidates(fields, &messages)
	if raw, ok := fields["runtimeOverrides"]; ok {
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
			messages = append(messages, "runtimeOverrides must be an object")
		} else {
			input.RuntimeOverrides = json.RawMessage(trimmed)
		}
	}
	if len(messages) > 0 {
		return TrialRunInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

func validateReplay(body []byte) (ReplayInput, error) {
	fields, err := parseFields(body)
	if err != nil {
		return ReplayInput{}, err
	}
	if err := rejectUnknown(fields, replayFields); err != nil {
		return ReplayInput{}, err
	}
	var input ReplayInput
	messages := []string{}
	if raw, ok := fields["seedUrl"]; ok {
		text, isString := jsonString(raw)
		if !isString || !isAbsoluteHTTPURL(text) {
			messages = append(messages, "seedUrl must be a URL address")
		} else {
			input.SeedURL = &text
		}
	}
	input.ProfileID = optionalIdentifier(fields, "profileId", &messages)
	input.NewsSourceID = optionalIdentifier(fields, "newsSourceId", &messages)
	input.MaxCandidates = optionalMaxCandidates(fields, &messages)
	if len(messages) > 0 {
		return ReplayInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// parseFields decodes a JSON object body. A non-object body behaves like `{}`.
func parseFields(body []byte) (map[string]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	if trimmed[0] != '{' {
		return map[string]json.RawMessage{}, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return nil, &inputError{Message: "Expected property name or '}' in JSON at position 1"}
	}
	return fields, nil
}

func rejectUnknown(fields map[string]json.RawMessage, allowed map[string]bool) error {
	messages := []string{}
	for key := range fields {
		if !allowed[key] {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return &inputError{Message: strings.Join(messages, "; ")}
	}
	return nil
}

// optionalIdentifier validates an @IsString @MaxLength(191) optional property.
func optionalIdentifier(fields map[string]json.RawMessage, key string, messages *[]string) *string {
	raw, ok := fields[key]
	if !ok {
		return nil
	}
	text, isString := jsonString(raw)
	if !isString {
		*messages = append(*messages, key+" must be a string")
		return nil
	}
	if utf16Len(text) > 191 {
		*messages = append(*messages, key+" must be shorter than or equal to 191 characters")
		return nil
	}
	return &text
}

// optionalMaxCandidates validates @Type(()=>Number) @IsInt @Min(1) @Max(500).
func optionalMaxCandidates(fields map[string]json.RawMessage, messages *[]string) *int {
	raw, ok := fields["maxCandidates"]
	if !ok {
		return nil
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		*messages = append(*messages, "maxCandidates must be an integer number")
		return nil
	}
	if number != float64(int64(number)) {
		*messages = append(*messages, "maxCandidates must be an integer number")
		return nil
	}
	value := int(number)
	if value < 1 {
		*messages = append(*messages, "maxCandidates must not be less than 1")
		return nil
	}
	if value > 500 {
		*messages = append(*messages, "maxCandidates must not be greater than 500")
		return nil
	}
	return &value
}

func jsonString(raw json.RawMessage) (string, bool) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// isAbsoluteHTTPURL mirrors @IsUrl({require_tld:false, require_protocol:true}).
func isAbsoluteHTTPURL(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed != value {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func utf16Len(value string) int {
	length := 0
	for _, char := range value {
		if char > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}

// ---- response writing ----

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var status *statusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.status, status.message)
		return
	}
	var discovery *crawlmetadata.DiscoveryError
	if errors.As(err, &discovery) {
		authhttp.WriteBadRequest(w, r, discovery.Error())
		return
	}
	var metadataInput *crawlmetadata.InputError
	if errors.As(err, &metadataInput) {
		authhttp.WriteBadRequest(w, r, metadataInput.Message)
		return
	}
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	if statusCode, message, ok := crawlworkflow.StatusOf(err); ok {
		authhttp.WriteHTTPException(w, r, statusCode, message)
		return
	}
	if crawlworkflow.IsInputError(err) {
		authhttp.WriteBadRequest(w, r, crawlworkflow.InputErrorMessage(err))
		return
	}
	if crawlprofile.IsInputError(err) {
		authhttp.WriteBadRequest(w, r, crawlprofile.InputErrorMessage(err))
		return
	}
	log.Printf("crawl discovery: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
