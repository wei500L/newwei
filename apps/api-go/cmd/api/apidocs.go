package main

import (
	"fmt"
	"log"
	"os"

	"github.com/wei500L/newwei/apps/api-go/internal/apidocs"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// wireAPIDocs registers the Go /docs takeover only when API_GO_DOCS_MODE=go.
// Every other value (including the legacy default and the empty string)
// registers nothing and returns without side effects, so the /docs prefix keeps
// proxying to NestJS and rollback is a single variable change.
//
// The takeover needs no database, Redis or JWT: the page, the OpenAPI document
// and every Swagger UI file come from go:embed. It does need SWAGGER_ENABLED,
// parsed with the same rules as the NestJS env schema; an unparsable value
// fails startup exactly like the NestJS process refuses to boot. The shared CORS
// policy and the exception recorder are injected by main.go so a Go-served 404
// carries the same headers and side-channel event as every other unmatched
// route.
func wireAPIDocs(gateway *legacyproxy.Gateway, cfg config.Config, policy cors.Policy, recorder nestnotfound.Recorder) error {
	if cfg.DocsMode != config.DocsModeGo {
		return nil
	}
	if gateway == nil {
		return fmt.Errorf("api-go: docs takeover requires a gateway")
	}
	enabled, err := apidocs.SwaggerEnabled(os.Getenv, cfg.NodeEnv)
	if err != nil {
		return fmt.Errorf("api-go: docs takeover: %w", err)
	}
	handler := apidocs.NewHandler(apidocs.Config{
		Enabled:  enabled,
		Policy:   policy,
		Recorder: recorder,
	})
	gateway.RegisterGoHandler(legacyproxy.DocsHandlerKey, handler.ServeHTTP)
	log.Printf("api-go: docs takeover mode=%s enabled=%t", cfg.DocsMode, enabled)
	return nil
}
