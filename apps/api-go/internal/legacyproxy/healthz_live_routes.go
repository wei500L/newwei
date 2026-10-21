package legacyproxy

import "net/http"

// healthzLivePath is the public liveness probe served by NestJS
// (apps/api/src/modules/health/health.controller.ts getLiveness). It is a
// migration unit and therefore keeps its own exact, GET-only rule.
const healthzLivePath = "/api/healthz/live"

// WithHealthzLive selects the execution owner of the public liveness probe
// GET /api/healthz/live (cutover C-1).
//
// The probe is a migration unit whose default owner is NestJS: the rule
// starts as ModeShadow so the response stays with NestJS while the Go handler
// (internal/health.LiveHandler, registered by cmd/api) is compared in the
// background. mode is API_GO_HEALTHZ_LIVE_MODE:
//
//	"" / "shadow" — keep the default shadow rule (no change at all);
//	"legacy"      — replace the rule with ModeLegacy (NestJS still answers);
//	"go"          — replace the rule with ModeGo (Go answers).
//
// Both non-default values keep the existing Exact + GET-only boundaries, so
// POST/HEAD/OPTIONS, similar paths (/api/healthz/liveness) and the trailing
// slash form keep falling through to the shorter /api/ legacy rule. Unknown
// values are rejected by config startup validation; the gateway keeps the
// default shadow rule instead of guessing (and therefore never stops the
// probe from being answered).
//
// The rule is replaced rather than appended: match() orders rules by prefix
// length with a stable sort, so an appended equal-length rule would sit behind
// the existing shadow rule and never be selected.
func WithHealthzLive(rules []Rule, mode string) []Rule {
	switch mode {
	case "", string(ModeShadow):
		return rules
	case string(ModeLegacy):
		return replaceHealthzLiveMode(rules, ModeLegacy)
	case string(ModeGo):
		return replaceHealthzLiveMode(rules, ModeGo)
	default:
		return rules
	}
}

// replaceHealthzLiveMode returns a copy of rules with the healthz-live rule's
// mode replaced. The existing Methods map (GET only) and Exact flag are kept
// as they are; a hand-built rule table without the default rule gets an
// equivalent exact GET-only rule appended.
func replaceHealthzLiveMode(rules []Rule, mode Mode) []Rule {
	out := make([]Rule, len(rules))
	copy(out, rules)
	for i := range out {
		if out[i].Prefix == healthzLivePath && out[i].Exact {
			out[i].Mode = mode
			return out
		}
	}
	return append(out, Rule{
		Prefix:  healthzLivePath,
		Mode:    mode,
		Exact:   true,
		Methods: map[string]bool{http.MethodGet: true},
	})
}
