package legacyproxy

import (
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// LegacyFallbackMode is what the Strangler gateway does with a request whose
// route resolution ends at NestJS.
//
// The zero value behaves like LegacyFallbackProxy, so a gateway that never
// calls SetLegacyFallback keeps proxying exactly as before.
type LegacyFallbackMode string

const (
	// LegacyFallbackProxy forwards every legacy request to NestJS
	// (LEGACY_API_URL). This is the default and the rollback value.
	LegacyFallbackProxy LegacyFallbackMode = "proxy"
	// LegacyFallbackReject answers the NestJS-equivalent 404 itself and never
	// contacts NestJS. It is the cutover C-9 answer: after NestJS is stopped,
	// a former proxy destination must not turn into a 502.
	LegacyFallbackReject LegacyFallbackMode = "reject"
)

// SetLegacyFallback selects the legacy fallback behaviour and installs the
// collaborators the reject mode needs: the CORS policy that answers browser
// preflights/the actual-response headers and the best-effort exception event
// recorder (may be nil).
//
// mode is API_GO_LEGACY_FALLBACK_MODE. The empty string, "proxy" and unknown
// values all keep (or restore) the original proxy behaviour; unknown values are
// rejected by config startup validation, so the gateway does not report an
// error of its own. The gateway must not be serving requests while this runs:
// cmd/api wires it once before the listener starts.
func (g *Gateway) SetLegacyFallback(mode string, policy cors.Policy, record nestnotfound.Recorder) {
	if LegacyFallbackMode(mode) == LegacyFallbackReject {
		g.legacyFallback = LegacyFallbackReject
		g.corsPolicy = policy
		g.notFoundRecorder = record
		return
	}
	g.legacyFallback = LegacyFallbackProxy
	g.corsPolicy = cors.Policy{}
	g.notFoundRecorder = nil
}

// rejectLegacy is the reject-mode exit for a request that would otherwise be
// forwarded to NestJS. It increments the cutover counter with the same bounded
// route-family label the proxy path uses, then writes the NestJS unmatched-route
// 404 (CORS preflight answered first). The reverse proxy is not touched, so a
// stopped NestJS can never surface as a 502 here.
func (g *Gateway) rejectLegacy(w http.ResponseWriter, r *http.Request) {
	metrics.RecordLegacyRejectedRequest(legacyRoutePrefix(r.URL.Path))
	nestnotfound.Write(w, r, g.corsPolicy, g.notFoundRecorder)
}
