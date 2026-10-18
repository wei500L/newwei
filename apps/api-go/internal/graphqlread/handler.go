package graphqlread

import (
	"context"
	"net/http"
	"sync/atomic"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/transport"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// Path is the exact GraphQL HTTP entry. Longer paths stay on the legacy prefix.
const Path = "/graphql"

// StatsPath exposes execution counters for the pilot smoke. It is not a public API.
const StatsPath = "/__go/graphql-read-stats"

// Handler is the Go GraphQL read entry. It decides legacy vs execute before any resolver runs.
type Handler struct {
	engine         *exec.Engine
	apq            *transport.APQCache
	apqEnabled     bool
	limiter        *policy.Limiter
	cache          *policy.ResponseCache
	cacheEnabled   bool
	cacheTTL       int
	auth           *authhttp.Authenticator
	legacy         func(http.ResponseWriter, *http.Request)
	cors           cors.Policy
	trustProxy     string
	schemaVersion  string
	resolverCalls  *atomic.Int64
	legacyForwards atomic.Int64
	protocolWrites atomic.Int64
	goResponses    atomic.Int64
}

// Options wires the read pilot. Registry must already contain the migrated roots.
type Options struct {
	Registry        *contract.Registry
	Authenticator   *authhttp.Authenticator
	Limiter         *policy.Limiter
	Cache           *policy.ResponseCache
	Legacy          func(http.ResponseWriter, *http.Request)
	CORS            cors.Policy
	TrustProxy      string
	APQEnabled      bool
	APQ             transport.APQConfig
	DepthLimit      int
	ComplexityLimit int
	CacheEnabled    bool
	CacheTTL        int
}

// NewHandler loads the embedded SDL and builds the executor.
func NewHandler(opts Options) (*Handler, error) {
	loaded, err := schema.Load()
	if err != nil {
		return nil, err
	}
	if opts.Registry == nil {
		opts.Registry = contract.NewRegistry()
	}
	calls := &atomic.Int64{}
	if opts.CacheTTL <= 0 {
		opts.CacheTTL = 30
	}
	return &Handler{
		engine:        exec.New(loaded, opts.Registry, opts.DepthLimit, opts.ComplexityLimit, calls),
		apq:           transport.NewAPQCache(opts.APQ),
		apqEnabled:    opts.APQEnabled,
		limiter:       opts.Limiter,
		cache:         opts.Cache,
		cacheEnabled:  opts.CacheEnabled,
		cacheTTL:      opts.CacheTTL,
		auth:          opts.Authenticator,
		legacy:        opts.Legacy,
		cors:          opts.CORS,
		trustProxy:    opts.TrustProxy,
		schemaVersion: schema.Version,
		resolverCalls: calls,
	}, nil
}

// Close releases the APQ document cache.
func (h *Handler) Close() {
	if h != nil {
		h.apq.Close()
	}
}

// Stats is the smoke counter snapshot.
type Stats struct {
	ResolverCalls  int64 `json:"resolverCalls"`
	LegacyForwards int64 `json:"legacyForwards"`
	ProtocolWrites int64 `json:"protocolWrites"`
	GoResponses    int64 `json:"goResponses"`
}

// Snapshot returns counters. ResolverCalls counts business root resolvers only.
func (h *Handler) Snapshot() Stats {
	if h == nil {
		return Stats{}
	}
	return Stats{
		ResolverCalls:  h.resolverCalls.Load(),
		LegacyForwards: h.legacyForwards.Load(),
		ProtocolWrites: h.protocolWrites.Load(),
		GoResponses:    h.goResponses.Load(),
	}
}

// ServeStats writes Snapshot as JSON.
func (h *Handler) ServeStats(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, h.Snapshot())
}

// ServeHTTP dispatches one exact /graphql request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if isUpgrade(r) {
		h.forward(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		if h.cors.FinishOptions(w, r) {
			return
		}
		h.forward(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		h.forward(w, r)
		return
	}
	body, tooBig, err := readLimitedBody(r)
	if err != nil {
		h.writeProtocol(w, r, exec.BadRequest("Could not read request body"))
		return
	}
	restoreBody(r, body)
	if tooBig {
		httpx.WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"statusCode": http.StatusRequestEntityTooLarge,
			"message":    "request entity too large",
			"error":      "Payload Too Large",
		})
		return
	}
	if isMultipart(r) || (r.Method == http.MethodPost && isJSONArray(body)) {
		h.forward(w, r)
		return
	}
	if csrfBlocked(r) {
		h.writeProtocol(w, r, exec.BadRequest(csrfMessage))
		return
	}
	req, err := parseGraphRequest(r, body)
	if err != nil {
		h.writeProtocol(w, r, exec.BadRequest("GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension."))
		return
	}
	query, persistHash, protocol := h.resolveAPQ(req)
	if protocol != nil {
		h.writeProtocol(w, r, *protocol)
		return
	}
	var opName *string
	if req.OperationName != nil {
		opName = req.OperationName
	}
	plan := h.engine.PlanDocument(query, opName, req.Variables)
	switch plan.Kind {
	case exec.KindLegacy:
		if plan.RegisterDocument && persistHash != "" {
			h.apq.Put(persistHash, query)
		}
		h.forward(w, r)
	case exec.KindProtocol:
		if plan.RegisterDocument && persistHash != "" {
			h.apq.Put(persistHash, query)
		}
		h.writeProtocol(w, r, plan.Result)
	case exec.KindExecute:
		// A GET request may never run a mutation. Apollo rejects it before the
		// operation is resolved, so no authentication, authorization, or write
		// happens; the response is 405 with an Allow: POST header.
		if r.Method == http.MethodGet {
			if reject := exec.MutationOverGET(plan); reject != nil {
				h.writeProtocol(w, r, *reject)
				return
			}
		}
		if tooComplex := h.engine.CheckComplexity(plan); tooComplex != nil {
			h.writeProtocol(w, r, *tooComplex)
			return
		}
		if persistHash != "" {
			h.apq.Put(persistHash, query)
		}
		budget := h.limiter.BudgetFor(r.Context())
		result := h.engine.Execute(r.Context(), plan, func(ctx context.Context, _, _ string) (contract.Identity, error) {
			if !h.limiter.Consume(ctx, clientIP(r, h.trustProxy), budget) {
				return contract.Identity{}, &contract.Failure{
					Message: "Too many GraphQL requests. Slow down.",
					Status:  http.StatusTooManyRequests,
				}
			}
			if h.auth == nil {
				return contract.Identity{}, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
			}
			identity, failure := h.auth.Identify(r.WithContext(ctx))
			if failure != nil {
				return contract.Identity{}, &contract.Failure{Message: failure.Message, Status: failure.Status}
			}
			return contract.Identity{
				UserID:      identity.UserID,
				OrgID:       identity.OrgID,
				Permissions: identity.PermissionSet(),
			}, nil
		}, h.cache, h.cacheEnabled && exec.ResponseCacheable(plan, h.cacheTTL), h.cacheTTL, h.schemaVersion, httpx.TraceIDFromContext(r.Context()))
		h.goResponses.Add(1)
		h.writeResult(w, r, result)
	default:
		h.forward(w, r)
	}
}

func (h *Handler) resolveAPQ(req graphRequest) (string, string, *exec.Result) {
	if req.Persisted == nil {
		if !req.QueryPresent || req.Query == "" {
			result := exec.BadRequest("GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.")
			return "", "", &result
		}
		return req.Query, "", nil
	}
	if !h.apqEnabled {
		result := exec.PersistedNotSupported()
		return "", "", &result
	}
	if !req.Persisted.VersionOK {
		result := exec.UnsupportedPersistedVersion()
		return "", "", &result
	}
	if !req.QueryPresent {
		query, ok := h.apq.Get(req.Persisted.Hash)
		if !ok {
			result := exec.PersistedNotFound()
			return "", "", &result
		}
		return query, "", nil
	}
	if transport.SHA256Hex(req.Query) != req.Persisted.Hash {
		result := exec.HashMismatch()
		return "", "", &result
	}
	return req.Query, req.Persisted.Hash, nil
}

func (h *Handler) forward(w http.ResponseWriter, r *http.Request) {
	h.legacyForwards.Add(1)
	if h.legacy != nil {
		h.legacy(w, r)
		return
	}
	http.Error(w, "legacy upstream unavailable", http.StatusBadGateway)
}

func (h *Handler) writeProtocol(w http.ResponseWriter, r *http.Request, result exec.Result) {
	h.protocolWrites.Add(1)
	h.writeResult(w, r, result)
}

func (h *Handler) writeResult(w http.ResponseWriter, r *http.Request, result exec.Result) {
	h.cors.FinishOptions(w, r)
	for key, values := range result.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", contentType(r.Header.Get("Accept")))
	}
	w.WriteHeader(result.Status)
	_, _ = w.Write(result.Body)
}

const csrfMessage = "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF). Please either specify a 'content-type' header (with a type that is not one of application/x-www-form-urlencoded, multipart/form-data, text/plain) or provide a non-empty value for one of the following headers: x-apollo-operation-name, apollo-require-preflight\n"
