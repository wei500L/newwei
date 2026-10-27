package config

import (
	"strings"
	"testing"
)

// TestCrawlDiscoveryModesDefaultToLegacy pins the default: unset and explicit
// legacy both keep the preview GET and the trial/replay POSTs on NestJS.
func TestCrawlDiscoveryModesDefaultToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.NewsSourcePreviewMode != NewsSourcePreviewModeGo {
		t.Fatalf("preview mode = %s", cfg.NewsSourcePreviewMode)
	}
	if cfg.CrawlWorkflowTrialMode != CrawlWorkflowTrialModeGo {
		t.Fatalf("trial mode = %s", cfg.CrawlWorkflowTrialMode)
	}
	if !cfg.CrawlJSCodeEnabled {
		t.Fatal("CRAWL4AI_JSCODE_ENABLED must default to true")
	}
	if cfg.NewsSourceInFlightLookbackMs != 21_600_000 {
		t.Fatalf("in-flight lookback = %d", cfg.NewsSourceInFlightLookbackMs)
	}
}

func TestCrawlDiscoveryModesRejectInvalid(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWS_SOURCE_PREVIEW_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWS_SOURCE_PREVIEW_MODE must be one of legacy|go") {
		t.Fatalf("invalid preview mode: %v", err)
	}
	_, err = Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_WORKFLOW_TRIAL_MODE" {
			return "canary"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_WORKFLOW_TRIAL_MODE must be one of legacy|go") {
		t.Fatalf("invalid trial mode: %v", err)
	}
}

// TestCrawlDiscoveryModesRequireCredentialsWithoutCrawl4ai pins the resource
// boundary: both entries need JWT/MySQL/Redis and must not require crawl4ai,
// matching NestJS where an unconfigured client degrades gracefully.
func TestCrawlDiscoveryModesRequireCredentialsWithoutCrawl4ai(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWS_SOURCE_PREVIEW_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_NEWS_SOURCE_PREVIEW_MODE=go") {
		t.Fatalf("missing credentials: %v", err)
	}
	_, err = Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_WORKFLOW_TRIAL_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_CRAWL_WORKFLOW_TRIAL_MODE=go") {
		t.Fatalf("missing credentials: %v", err)
	}

	base := func(key string) string {
		switch key {
		case "API_GO_NEWS_SOURCE_PREVIEW_MODE", "API_GO_CRAWL_WORKFLOW_TRIAL_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	}
	cfg, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsSourcePreviewMode != NewsSourcePreviewModeGo || cfg.CrawlWorkflowTrialMode != CrawlWorkflowTrialModeGo {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.CrawlBaseURL != "" {
		t.Fatal("crawl4ai must stay optional")
	}
}
