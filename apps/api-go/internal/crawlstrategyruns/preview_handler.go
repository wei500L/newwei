package crawlstrategyruns

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// PreviewPathPrefix is the exact news-source preview subtree. Only
// `/<id>/preview` is taken over; every other news-source path keeps its own
// switch and NestJS fallback.
const PreviewPathPrefix = "/api/admin/news-sources/"

const previewPermission = "crawl.read"

// PreviewHandler serves GET /api/admin/news-sources/:id/preview.
type PreviewHandler struct {
	auth    *authhttp.Authenticator
	runtime *Runtime
	preview *PreviewService
}

// NewPreviewHandler builds the preview handler around the shared authenticator,
// runtime (machine-token resolution) and preview service.
func NewPreviewHandler(auth *authhttp.Authenticator, runtime *Runtime, preview *PreviewService) *PreviewHandler {
	return &PreviewHandler{auth: auth, runtime: runtime, preview: preview}
}

// ServeHTTP dispatches the single GET route.
func (h *PreviewHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	id, ok := previewTarget(r.URL.Path)
	if !ok {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	payload, err := h.preview.Preview(r.Context(), identity.OrgID, id)
	if err != nil {
		writePreviewError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func previewTarget(path string) (string, bool) {
	const suffix = "/preview"
	if !strings.HasPrefix(path, PreviewPathPrefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	rest := strings.TrimSuffix(path[len(PreviewPathPrefix):], suffix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func (h *PreviewHandler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.preview == nil || h.auth == nil {
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
		if h.runtime == nil || h.runtime.workflows == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		resolved, err := h.runtime.workflows.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writePreviewError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(previewPermission) {
		authhttp.WriteForbidden(w, r, []string{previewPermission})
		return nil
	}
	return identity
}

func writePreviewError(w http.ResponseWriter, r *http.Request, err error) {
	var policy *crawlprofile.PolicyError
	if errors.As(err, &policy) {
		authhttp.WriteBadRequest(w, r, policy.Message)
		return
	}
	var discovery *crawlmetadata.DiscoveryError
	if errors.As(err, &discovery) {
		authhttp.WriteBadRequest(w, r, discovery.Error())
		return
	}
	var status *statusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.status, status.message)
		return
	}
	log.Printf("news source preview: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
