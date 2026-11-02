package config

import (
	"bufio"
	"math"
	"os"
	"strings"
	"testing"
)

// readEnvFixture parses a KEY=VALUE fixture. Blank lines and lines starting with
// '#' are ignored; values are never defaulted here.
func readEnvFixture(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	env := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("invalid fixture line %q in %s", line, path)
		}
		env[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return env
}

// defaultResources returns the connection and secret placeholders the gateway
// needs at startup. The Go-only runtime validates every migrated unit's
// resources unconditionally, so this fixture supplies all of them.
func defaultResources(t *testing.T) map[string]string {
	t.Helper()
	return readEnvFixture(t, "testdata/default-resources.env")
}

// resourceEnv layers the test overrides on top of the placeholder resources. An
// empty override removes the key, which is how a missing resource is simulated.
func resourceEnv(t *testing.T, overrides map[string]string) func(string) string {
	t.Helper()
	env := defaultResources(t)
	for key, value := range overrides {
		if value == "" {
			delete(env, key)
			continue
		}
		env[key] = value
	}
	return func(key string) string { return env[key] }
}

func loadDefaults(t *testing.T) Config {
	t.Helper()
	cfg, err := Load(resourceEnv(t, nil))
	if err != nil {
		t.Fatalf("config.Load rejected the default resource fixture: %v", err)
	}
	return cfg
}

func loadWith(t *testing.T, overrides map[string]string) (Config, error) {
	t.Helper()
	return Load(resourceEnv(t, overrides))
}

// loadMissing loads the default fixture with the named resource variables removed.
func loadMissing(t *testing.T, keys ...string) (Config, error) {
	t.Helper()
	env := defaultResources(t)
	for _, key := range keys {
		delete(env, key)
	}
	return Load(func(key string) string { return env[key] })
}

func TestLoadDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.Port != 4020 {
		t.Errorf("Port = %d, want 4020", cfg.Port)
	}
	if !cfg.ScheduleEnabled {
		t.Error("ScheduleEnabled should default to true")
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	if _, err := loadWith(t, map[string]string{"PORT": "-1"}); err == nil {
		t.Fatal("Load() should reject PORT=-1")
	}
}

func TestLoadAcceptsExplicitConfig(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"PORT": "8080"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 8080 {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestScheduleEnabledParsing(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"SCHEDULE_ENABLED": "false"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ScheduleEnabled {
		t.Error("SCHEDULE_ENABLED=false must disable scheduling")
	}
}

// TestRequiredResourcesAreValidatedUnconditionally asserts that a Go-only
// deployment refuses to start when any migrated unit's backing resource is
// absent. The requirement messages are no longer scoped to a migration switch.
func TestRequiredResourcesAreValidatedUnconditionally(t *testing.T) {
	cases := []struct {
		key  string
		want string
	}{
		{"JWT_SECRET", "JWT_SECRET is required"},
		{"DATABASE_URL", "DATABASE_URL is required"},
		{"REDIS_HOST", "REDIS_HOST is required"},
		{"MONGO_URI", "MONGO_URI is required"},
		{"SMTP_HOST", "SMTP_HOST is required"},
		{"SMTP_PORT", "SMTP_PORT is required"},
		{"SMTP_USER", "SMTP_USER is required"},
		{"SMTP_PASS", "SMTP_PASS is required"},
		{"SYSTEM_SETTINGS_ENCRYPTION_KEY", "SYSTEM_SETTINGS_ENCRYPTION_KEY is required"},
		{"CRAWL4AI_BASE_URL", "CRAWL4AI_BASE_URL is required"},
	}
	for _, tc := range cases {
		_, err := loadMissing(t, tc.key)
		if err == nil {
			t.Errorf("missing %s must fail startup", tc.key)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("missing %s error %q does not contain %q", tc.key, err, tc.want)
		}
	}
}

func TestGraphQLSubscriptionBusMustBeRedis(t *testing.T) {
	if _, err := loadWith(t, map[string]string{"GRAPHQL_SUBSCRIPTION_BUS": "local"}); err == nil || !strings.Contains(err.Error(), "GRAPHQL_SUBSCRIPTION_BUS must be redis") {
		t.Fatalf("Load() error = %v, want redis-bus rejection", err)
	}
	if _, err := loadWith(t, map[string]string{"GRAPHQL_SUBSCRIPTION_BUS": "memory"}); err == nil || !strings.Contains(err.Error(), "GRAPHQL_SUBSCRIPTION_BUS must be one of redis|local") {
		t.Fatalf("Load() error = %v, want bus vocabulary rejection", err)
	}
}

func TestAuthLoginDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.JWTAccessExpiresIn != "15m" || cfg.JWTRefreshExpiresIn != "7d" {
		t.Fatalf("jwt lifetimes = %q / %q", cfg.JWTAccessExpiresIn, cfg.JWTRefreshExpiresIn)
	}
	if cfg.AuthRefreshGraceSeconds != 10 || cfg.AuthMfaChallengeMaxAttempts != 5 {
		t.Fatalf("grace/attempts = %d / %d", cfg.AuthRefreshGraceSeconds, cfg.AuthMfaChallengeMaxAttempts)
	}
	if cfg.AuthEmailCodeTTLSeconds != 300 || cfg.AuthEmailCodeCooldownSeconds != 90 || cfg.AuthEmailCodeMaxAttempts != 3 {
		t.Fatalf("email code defaults = %d / %d / %d",
			cfg.AuthEmailCodeTTLSeconds, cfg.AuthEmailCodeCooldownSeconds, cfg.AuthEmailCodeMaxAttempts)
	}
	if cfg.NextAuthURL != "http://localhost:3000" {
		t.Fatalf("nextauth url = %q", cfg.NextAuthURL)
	}
	if !cfg.SMTP.Secure || cfg.SMTP.Pool {
		t.Fatalf("smtp defaults = %+v", cfg.SMTP)
	}
	if cfg.SMTP.ConnectionTimeoutMs != 10_000 || cfg.SMTP.GreetingTimeoutMs != 10_000 || cfg.SMTP.SocketTimeoutMs != 30_000 {
		t.Fatalf("smtp timeouts = %+v", cfg.SMTP)
	}
}

func TestCrawlMaintenanceJanitorEnvOverrides(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"CRAWL_TASK_JANITOR_ENABLED":          "false",
		"CRAWL_TASK_RUNNING_TIMEOUT_MS":       "9000",
		"CRAWL_TASK_QUEUED_TIMEOUT_MS":        "12345",
		"CRAWL_TASK_JANITOR_BATCH_SIZE":       "7",
		"CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT": "99",
		"CRAWL_TASK_JANITOR_LOCK_TTL_MS":      "60000",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTaskJanitorEnabled ||
		cfg.CrawlTaskRunningTimeoutMs != 9000 ||
		cfg.CrawlTaskQueuedTimeoutMs != 12345 ||
		cfg.CrawlTaskJanitorBatchSize != 7 ||
		cfg.CrawlTaskJanitorQueueScanLimit != 99 ||
		cfg.CrawlTaskJanitorLockTTLMs != 60000 {
		t.Fatalf("janitor overrides = %+v", cfg)
	}
}

func TestCrawlWorkerMediaDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.CrawlMediaFetchTimeoutMs != 15_000 {
		t.Errorf("media fetch timeout = %d", cfg.CrawlMediaFetchTimeoutMs)
	}
	if cfg.CrawlMediaMaxBytes != 2_097_152 {
		t.Errorf("media max bytes = %d", cfg.CrawlMediaMaxBytes)
	}
	if cfg.CrawlMediaMaxPerResult != 6 {
		t.Errorf("media max per result = %d", cfg.CrawlMediaMaxPerResult)
	}
}

func TestCrawl4aiEnvironmentDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.CrawlMaxConcurrency != 3 || cfg.CrawlMaxRetries != 3 || cfg.CrawlRetryBackoffMs != 5000 {
		t.Fatalf("defaults = %d/%d/%d", cfg.CrawlMaxConcurrency, cfg.CrawlMaxRetries, cfg.CrawlRetryBackoffMs)
	}
	cfg, err := loadWith(t, map[string]string{
		"CRAWL4AI_MAX_CONCURRENCY":  "7",
		"CRAWL4AI_MAX_RETRIES":      "4",
		"CRAWL4AI_RETRY_BACKOFF_MS": "900",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMaxConcurrency != 7 || cfg.CrawlMaxRetries != 4 || cfg.CrawlRetryBackoffMs != 900 {
		t.Fatalf("env values = %d/%d/%d", cfg.CrawlMaxConcurrency, cfg.CrawlMaxRetries, cfg.CrawlRetryBackoffMs)
	}
}

func TestItemPipelineFailureConfigDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.NewsSourceSchedulerFailureRecoveryDelayMs != 600_000 {
		t.Errorf("failure recovery delay = %d", cfg.NewsSourceSchedulerFailureRecoveryDelayMs)
	}
	if cfg.NewsSourceSchedulerFailureMaxDelayMs != 21_600_000 {
		t.Errorf("failure max delay = %d", cfg.NewsSourceSchedulerFailureMaxDelayMs)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerThreshold != 3 {
		t.Errorf("circuit breaker threshold = %v", cfg.NewsSourceSchedulerCircuitBreakerThreshold)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs != 3_600_000 {
		t.Errorf("circuit breaker base delay = %d", cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs != 86_400_000 {
		t.Errorf("circuit breaker max delay = %d", cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs)
	}
	if cfg.NewsSourceSchedulerAutoDisableThreshold != 0 {
		t.Errorf("auto disable threshold = %v", cfg.NewsSourceSchedulerAutoDisableThreshold)
	}
}

func TestNewsEventsIngestionSettleWindowParsing(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"NEWS_EVENTS_INGESTION_SETTLE_MS": "0"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionSettleMs != 0 {
		t.Fatalf("settle = %d, want 0", cfg.NewsEventsIngestionSettleMs)
	}

	cfg, err = loadWith(t, map[string]string{"NEWS_EVENTS_INGESTION_SETTLE_MS": " 45000 "})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionSettleMs != 45_000 {
		t.Fatalf("settle = %d, want 45000", cfg.NewsEventsIngestionSettleMs)
	}

	for _, invalid := range []string{"-1", "soon", "1.5"} {
		_, err := loadWith(t, map[string]string{"NEWS_EVENTS_INGESTION_SETTLE_MS": invalid})
		if err == nil || !strings.Contains(err.Error(), "NEWS_EVENTS_INGESTION_SETTLE_MS must be a non-negative integer") {
			t.Fatalf("%q => %v", invalid, err)
		}
	}
}

func TestQualityWorkerConcurrency(t *testing.T) {
	cases := map[int]int{0: 2, 1: 1, 2: 2, 3: 3, 4: 4, 8: 4, 64: 4}
	for configured, want := range cases {
		cfg := Config{NewsProcessQueueConcurrency: configured}
		if got := cfg.QualityWorkerConcurrency(); got != want {
			t.Fatalf("configured=%d concurrency=%d, want %d", configured, got, want)
		}
	}
}

func TestNewsProcessQueueConcurrencyParsing(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"NEWS_PROCESS_QUEUE_CONCURRENCY": "3"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsProcessQueueConcurrency != 3 || cfg.QualityWorkerConcurrency() != 3 {
		t.Fatalf("configured = %d", cfg.NewsProcessQueueConcurrency)
	}

	for _, invalid := range []string{"0", "-1", "many"} {
		_, err := loadWith(t, map[string]string{"NEWS_PROCESS_QUEUE_CONCURRENCY": invalid})
		if err == nil || !strings.Contains(err.Error(), "NEWS_PROCESS_QUEUE_CONCURRENCY must be a positive integer") {
			t.Fatalf("value %q error = %v", invalid, err)
		}
	}
}

func TestNotificationsSocketRejectsInvalidLimits(t *testing.T) {
	if _, err := loadWith(t, map[string]string{"WS_CONNECT_RATE_LIMIT_PER_IP": "0"}); err == nil {
		t.Fatal("Load() should reject non-positive WS limits")
	}
}

func TestWSRedisAdapterConfigParsing(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"WS_REDIS_ADAPTER_ENABLED": "on", "WS_REDIS_ADAPTER_KEY": "custom-key"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.WSRedisAdapterEnabled || cfg.WSRedisAdapterKey != "custom-key" {
		t.Fatalf("unexpected adapter config: enabled=%t key=%q", cfg.WSRedisAdapterEnabled, cfg.WSRedisAdapterKey)
	}
	if cfg, err := loadWith(t, map[string]string{"WS_REDIS_ADAPTER_KEY": ""}); err != nil {
		t.Fatalf("Load() error = %v", err)
	} else if cfg.WSRedisAdapterKey != "socket.io" {
		t.Fatalf("default adapter key = %q, want socket.io", cfg.WSRedisAdapterKey)
	}
	if _, err := loadWith(t, map[string]string{"WS_REDIS_ADAPTER_ENABLED": "maybe"}); err == nil || !strings.Contains(err.Error(), "WS_REDIS_ADAPTER_ENABLED must be a boolean") {
		t.Fatalf("Load() error = %v, want boolean rejection", err)
	}
}

func TestDataRuntimeSettingsEnvDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	env := cfg.DataRuntimeSettings
	if !env.RealtimeEnabled || env.RealtimeRequestTimeoutMs != 12_000 || env.RealtimeMaxRetries != 2 {
		t.Fatalf("realtime scalars = %+v", env)
	}
	if !env.RealtimeOpenskyEnabled || env.RealtimeOpenskyIntervalSec != 900 ||
		env.RealtimeOpenskyDailyCreditBudget != 4000 || env.RealtimeOpenskyDayIntervalSec != 600 ||
		env.RealtimeOpenskyNightIntervalSec != 1800 || env.RealtimeOpenskyDayStartHourHKT != 8 ||
		env.RealtimeOpenskyNightStartHourHKT != 22 || env.RealtimeOpenskyWarningRemaining != 20 ||
		env.RealtimeOpenskyCriticalRemaining != 10 {
		t.Fatalf("opensky defaults = %+v", env)
	}
	if env.RealtimeOpenskyBaseURL != "https://opensky-network.org/api" {
		t.Fatalf("opensky base url = %q", env.RealtimeOpenskyBaseURL)
	}
	if env.RealtimeAisIntervalSec != 600 || env.RealtimeUnrestIntervalSec != 600 ||
		env.RealtimeOutagesIntervalSec != 600 || env.RealtimeKeywordSpikeIntervalSec != 600 ||
		env.RealtimePizzintIntervalSec != 600 || env.RealtimeGdeltTensionIntervalSec != 600 ||
		env.RealtimePolymarketIntervalSec != 600 {
		t.Fatalf("interval defaults = %+v", env)
	}
	if env.RealtimeKeywordSpikeMinCount != 5 || env.RealtimeKeywordSpikeMultiplier != 3 ||
		env.RealtimePredictionShiftThreshold != 5 || env.RealtimePredictionNewsThreshold != 3 {
		t.Fatalf("threshold defaults = %+v", env)
	}
	if env.NominatimUserAgentDefault != "modular-api" || env.NominatimEmailDefault != "" {
		t.Fatalf("nominatim defaults = %+v", env)
	}
}

func TestDataRuntimeSettingsEnvPassThrough(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"REALTIME_SIGNALS_ENABLED":                    " off ",
		"REALTIME_SIGNALS_REQUEST_TIMEOUT_MS":         "9000",
		"REALTIME_SIGNALS_MAX_RETRIES":                "0",
		"REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC":       "120",
		"REALTIME_SIGNALS_ADSB_ENABLED":               "false",
		"REALTIME_SIGNALS_ADSB_INTERVAL_SEC":          "45",
		"REALTIME_SIGNALS_RELAY_BASE_URL":             "https://relay.example",
		"AIS_RELAY_SHARED_SECRET":                     "relay-secret",
		"REALTIME_SIGNALS_KEYWORD_SPIKE_MULTIPLIER":   "2.5",
		"REALTIME_SIGNALS_PREDICTION_SHIFT_THRESHOLD": "4.5",
		"REALTIME_SIGNALS_POLYMARKET_PROXY_URL":       "https://proxy.example",
		"GEO_NOMINATIM_USER_AGENT":                    "custom-agent",
		"GEO_NOMINATIM_EMAIL":                         "geocoder@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	env := cfg.DataRuntimeSettings
	if env.RealtimeEnabled || env.RealtimeRequestTimeoutMs != 9000 || env.RealtimeMaxRetries != 0 {
		t.Fatalf("realtime scalars = %+v", env)
	}
	if !env.RealtimeOpenskyEnabled || env.RealtimeOpenskyIntervalSec != 120 {
		t.Fatalf("opensky precedence = %+v", env)
	}
	if env.RealtimeAisBaseURL != "https://relay.example" || env.RealtimeAisSharedSecret != "relay-secret" {
		t.Fatalf("ais fallbacks = %+v", env)
	}
	if env.RealtimeKeywordSpikeMultiplier != 2.5 || env.RealtimePredictionShiftThreshold != 4.5 {
		t.Fatalf("float thresholds = %+v", env)
	}
	if env.RealtimePolymarketProxyURL != "https://proxy.example" {
		t.Fatalf("proxy url = %q", env.RealtimePolymarketProxyURL)
	}
	if env.NominatimUserAgentDefault != "custom-agent" || env.NominatimEmailDefault != "geocoder@example.com" {
		t.Fatalf("nominatim = %+v", env)
	}
}

func TestAlertingConfigDefaultsAndBounds(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.AlertQueueConcurrency != 4 ||
		cfg.AlertWebhookTimeoutMs != 5_000 ||
		cfg.AlertScanIntervalMs != 300_000 ||
		cfg.AlertNotifyGlobalPerSec != 10 ||
		cfg.AlertNotifyEmailPerSec != 2 ||
		cfg.AlertNotifyWebhookPerSec != 10 ||
		cfg.AlertNotifyPerChannelPSec != 2 ||
		cfg.AlertNotifyLimiterTTLMs != 60_000 ||
		cfg.BullMQNamespace != "modular" {
		t.Fatalf("alerting defaults = %+v", cfg)
	}

	cfg, err := loadWith(t, map[string]string{
		"ALERT_QUEUE_CONCURRENCY":             "8",
		"ALERT_WEBHOOK_TIMEOUT_MS":            "2500",
		"ALERT_SCAN_INTERVAL_MS":              "60000",
		"ALERT_NOTIFY_GLOBAL_PER_SECOND":      "0",
		"ALERT_NOTIFY_EMAIL_PER_SECOND":       "1",
		"ALERT_NOTIFY_WEBHOOK_PER_SECOND":     "3",
		"ALERT_NOTIFY_PER_CHANNEL_PER_SECOND": "4",
		"ALERT_NOTIFY_LIMITER_TTL_MS":         "120000",
		"BULLMQ_NAMESPACE":                    "custom",
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AlertQueueConcurrency != 8 ||
		cfg.AlertWebhookTimeoutMs != 2_500 ||
		cfg.AlertScanIntervalMs != 60_000 ||
		cfg.AlertNotifyGlobalPerSec != 0 ||
		cfg.AlertNotifyEmailPerSec != 1 ||
		cfg.AlertNotifyWebhookPerSec != 3 ||
		cfg.AlertNotifyPerChannelPSec != 4 ||
		cfg.AlertNotifyLimiterTTLMs != 120_000 ||
		cfg.BullMQNamespace != "custom" {
		t.Fatalf("alerting values = %+v", cfg)
	}

	for _, key := range []string{
		"ALERT_QUEUE_CONCURRENCY",
		"ALERT_WEBHOOK_TIMEOUT_MS",
		"ALERT_SCAN_INTERVAL_MS",
		"ALERT_NOTIFY_LIMITER_TTL_MS",
	} {
		if _, err := loadWith(t, map[string]string{key: "0"}); err == nil {
			t.Errorf("%s=0 must be rejected", key)
		}
	}
	if _, err := loadWith(t, map[string]string{"ALERT_NOTIFY_GLOBAL_PER_SECOND": "-1"}); err == nil {
		t.Error("negative per-second rate must be rejected")
	}
}

func TestNewsSourceSchedulerSourceConcurrency(t *testing.T) {
	for raw, want := range map[string]int{"0": 1, "-2": 1, "4": 4} {
		cfg, err := loadWith(t, map[string]string{"NEWS_SOURCE_SCHEDULER_SOURCE_CONCURRENCY": raw})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.NewsSourceScheduler.SourceConcurrency != want {
			t.Errorf("NEWS_SOURCE_SCHEDULER_SOURCE_CONCURRENCY=%q source concurrency = %d, want %d",
				raw, cfg.NewsSourceScheduler.SourceConcurrency, want)
		}
	}
}

func TestAnalysisPromptEmptyStringIsConfigured(t *testing.T) {
	lookup := func(key string) (string, bool) {
		if key == "ANALYSIS_PROMPT_CORRELATION_SYSTEM" {
			return "", true
		}
		return "", false
	}
	cfg, err := load(resourceEnv(t, nil), lookup)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.AnalysisPrompts.CorrelationSystem == nil {
		t.Fatal("an explicitly empty prompt must be reported as configured")
	}
	if *cfg.AnalysisPrompts.CorrelationSystem != "" {
		t.Fatalf("prompt = %q, want empty", *cfg.AnalysisPrompts.CorrelationSystem)
	}
}

func TestAnalysisFlushBoundsClamp(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"ANALYSIS_STREAM_FLUSH_CHARS": "0",
		"ANALYSIS_STREAM_FLUSH_MS":    "-5",
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.AnalysisStreamFlushChars != 1 {
		t.Fatalf("flushChars = %d, want 1", cfg.AnalysisStreamFlushChars)
	}
	if cfg.AnalysisStreamFlushMs != 0 {
		t.Fatalf("flushMs = %d, want 0", cfg.AnalysisStreamFlushMs)
	}
}

func TestBullMQWorkersEnabledDefaultsTrue(t *testing.T) {
	cfg := loadDefaults(t)
	if !cfg.BullMQWorkersEnabled {
		t.Fatal("BULLMQ_WORKERS_ENABLED should default to true")
	}
	disabled, err := loadWith(t, map[string]string{"BULLMQ_WORKERS_ENABLED": "false"})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if disabled.BullMQWorkersEnabled {
		t.Fatal("BULLMQ_WORKERS_ENABLED=false was ignored")
	}
}

func TestPlatformGovernanceDefaultsMatchNestSchema(t *testing.T) {
	cfg := loadDefaults(t)
	if !cfg.PlatformGovernanceAssistantGuardrailsEnabled {
		t.Error("ASSISTANT_GUARDRAILS_ENABLED default = false, want true")
	}
	if cfg.PlatformGovernanceAssistantGuardrailsRaw != "openai-moderation-pre" {
		t.Errorf("ASSISTANT_GUARDRAILS default = %q", cfg.PlatformGovernanceAssistantGuardrailsRaw)
	}
	if cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour != 30 {
		t.Errorf("ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR default = %d, want 30", cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour)
	}
	if cfg.PlatformGovernanceAssistantOrgMaxInFlight != 2 {
		t.Errorf("ASSISTANT_ORG_MAX_IN_FLIGHT default = %d, want 2", cfg.PlatformGovernanceAssistantOrgMaxInFlight)
	}
	if cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget != 2_000_000 {
		t.Errorf("ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET default = %d, want 2000000", cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget)
	}
	if cfg.PlatformGovernanceTaskLogRetentionDays != 14 {
		t.Errorf("TASK_LOG_RETENTION_DAYS default = %d, want 14", cfg.PlatformGovernanceTaskLogRetentionDays)
	}
}

func TestJSEnvNumberSemantics(t *testing.T) {
	nanValues := []string{"nan", "inf", "1_000", "0x1p3", "0x", "1,5", "  12 3 ", "0x1g"}
	for _, raw := range nanValues {
		if got := jsEnvNumber(raw); !math.IsNaN(got) {
			t.Errorf("jsEnvNumber(%q) = %v, want NaN", raw, got)
		}
	}
	if got := jsEnvNumber("Infinity"); !math.IsInf(got, 1) {
		t.Errorf("jsEnvNumber(Infinity) = %v, want +Inf", got)
	}
	if got := jsEnvNumber("-Infinity"); !math.IsInf(got, -1) {
		t.Errorf("jsEnvNumber(-Infinity) = %v, want -Inf", got)
	}
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{"", 0},
		{"   ", 0},
		{"30", 30},
		{" 30 ", 30},
		{"+30", 30},
		{"-30", -30},
		{".5", 0.5},
		{"5.", 5},
		{"1e3", 1000},
		{"1E+3", 1000},
		{"0x1f", 31},
		{"0X1F", 31},
		{"0o17", 15},
		{"0b101", 5},
	} {
		if got := jsEnvNumber(tc.raw); got != tc.want {
			t.Errorf("jsEnvNumber(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestResourceFixtureIsPlaceholdersOnly(t *testing.T) {
	raw, err := os.ReadFile("testdata/default-resources.env")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	text := strings.ToLower(string(raw))
	for _, forbidden := range []string{"sk-", "-----begin", "akia"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("testdata/default-resources.env contains something that looks like a real credential: %q", forbidden)
		}
	}
}

func TestInfrastructureSettingsEnvDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.VectorServiceEnabled || !cfg.VectorServiceFallbackToMongo {
		t.Fatalf("vector booleans = %v %v", cfg.VectorServiceEnabled, cfg.VectorServiceFallbackToMongo)
	}
	if cfg.VectorServiceBaseURL != "" || cfg.VectorInternalToken != "" {
		t.Fatalf("vector url/token = %q %q", cfg.VectorServiceBaseURL, cfg.VectorInternalToken)
	}
	if cfg.VectorServiceTimeoutMs != 5000 || cfg.VectorServiceMaxRetries != 2 {
		t.Fatalf("vector timings = %d %d", cfg.VectorServiceTimeoutMs, cfg.VectorServiceMaxRetries)
	}
	if cfg.S3AccessKeyID != "" || cfg.S3SecretAccessKey != "" || cfg.S3Bucket != "" || cfg.S3Endpoint != "" {
		t.Fatalf("s3 defaults = %+v", cfg)
	}
	if cfg.S3Region != "us-east-1" || cfg.S3ForcePathStyle || cfg.S3PresignedURLTTLSeconds != 300 {
		t.Fatalf("s3 scalars = %q %v %d", cfg.S3Region, cfg.S3ForcePathStyle, cfg.S3PresignedURLTTLSeconds)
	}

	cfg, err := loadWith(t, map[string]string{
		"VECTOR_SERVICE_ENABLED":           " Yes ",
		"VECTOR_SERVICE_FALLBACK_TO_MONGO": "off",
		"VECTOR_SERVICE_TIMEOUT_MS":        "9000",
		"VECTOR_SERVICE_MAX_RETRIES":       "0",
		"S3_FORCE_PATH_STYLE":              "true",
		"S3_PRESIGNED_URL_TTL_SECONDS":     "600",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY":   "not-a-real-key",
		"NODE_ENV":                         "production",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.VectorServiceEnabled || cfg.VectorServiceFallbackToMongo {
		t.Fatalf("vector booleans = %v %v", cfg.VectorServiceEnabled, cfg.VectorServiceFallbackToMongo)
	}
	if cfg.VectorServiceTimeoutMs != 9000 || cfg.VectorServiceMaxRetries != 0 {
		t.Fatalf("vector timings = %d %d", cfg.VectorServiceTimeoutMs, cfg.VectorServiceMaxRetries)
	}
	if !cfg.S3ForcePathStyle || cfg.S3PresignedURLTTLSeconds != 600 {
		t.Fatalf("s3 scalars = %v %d", cfg.S3ForcePathStyle, cfg.S3PresignedURLTTLSeconds)
	}
	if !cfg.SettingsEncryptionKeyPresent || cfg.SettingsEncryptionKeyRaw != "not-a-real-key" {
		t.Fatalf("encryption key presence = %v %q", cfg.SettingsEncryptionKeyPresent, cfg.SettingsEncryptionKeyRaw)
	}
	if cfg.NodeEnv != "production" {
		t.Fatalf("node env = %q", cfg.NodeEnv)
	}
}

func TestModelAccessRawEnvIsCapturedUntrimmed(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"MODEL_SERVICE_ENABLED":          " yes ",
		"MODEL_SERVICE_BASE_URL":         " http://model-service:8090 ",
		"MODEL_SERVICE_INTERNAL_TOKEN":   " tok ",
		"MODEL_SERVICE_TIMEOUT_MS":       "12000",
		"MODEL_SERVICE_MAX_RETRIES":      "3",
		"LITELLM_CONFIG_INTERNAL_TOKEN":  " litellm-token ",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY": " key ",
		"NODE_ENV":                       "production",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ModelServiceEnabledRaw != " yes " {
		t.Fatalf("ModelServiceEnabledRaw = %q", cfg.ModelServiceEnabledRaw)
	}
	if cfg.ModelServiceBaseURLRaw != " http://model-service:8090 " {
		t.Fatalf("ModelServiceBaseURLRaw = %q", cfg.ModelServiceBaseURLRaw)
	}
	if cfg.ModelServiceInternalTokenRaw != " tok " {
		t.Fatalf("ModelServiceInternalTokenRaw = %q", cfg.ModelServiceInternalTokenRaw)
	}
	if cfg.ModelServiceTimeoutMsRaw != "12000" || cfg.ModelServiceMaxRetriesRaw != "3" {
		t.Fatalf("numeric raw values = %q / %q", cfg.ModelServiceTimeoutMsRaw, cfg.ModelServiceMaxRetriesRaw)
	}
	if cfg.LiteLLMConfigInternalTokenRaw != " litellm-token " {
		t.Fatalf("LiteLLMConfigInternalTokenRaw = %q", cfg.LiteLLMConfigInternalTokenRaw)
	}
	if cfg.NodeEnvRaw != "production" {
		t.Fatalf("NodeEnvRaw = %q", cfg.NodeEnvRaw)
	}
	if cfg.SettingsEncryptionKey != "key" {
		t.Fatalf("SettingsEncryptionKey = %q, want the trimmed value", cfg.SettingsEncryptionKey)
	}
	if cfg.SystemSettingsEncryptionKeyRaw != " key " {
		t.Fatalf("SystemSettingsEncryptionKeyRaw = %q, want the raw value", cfg.SystemSettingsEncryptionKeyRaw)
	}
}

func TestLLMGatewayProfileEnvProjectionDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.LLMGatewayModel != "openai/gpt-4o-mini" {
		t.Fatalf("model = %q", cfg.LLMGatewayModel)
	}
	if cfg.LiteLLMAPIBase != "http://localhost:4001" {
		t.Fatalf("apiBase = %q", cfg.LiteLLMAPIBase)
	}
	if cfg.LiteLLMTimeoutMs != 60_000 {
		t.Fatalf("timeoutMs = %d", cfg.LiteLLMTimeoutMs)
	}
	if cfg.LLMGatewayTemperature != 0.2 {
		t.Fatalf("temperature = %v", cfg.LLMGatewayTemperature)
	}
	if cfg.LLMGatewayTopP != 0.9 {
		t.Fatalf("topP = %v", cfg.LLMGatewayTopP)
	}
	if cfg.LLMGatewayMaxOutputTokens != 2048 {
		t.Fatalf("maxOutputTokens = %d", cfg.LLMGatewayMaxOutputTokens)
	}
	if cfg.LLMGatewayMaxRetries != 3 {
		t.Fatalf("maxRetries = %d", cfg.LLMGatewayMaxRetries)
	}
	if len(cfg.LLMGatewayFallbackModels) != 0 {
		t.Fatalf("fallbackModels = %v", cfg.LLMGatewayFallbackModels)
	}
	if cfg.NodeEnvProduction {
		t.Fatal("NODE_ENV unset must not be production")
	}
}

func TestLLMGatewayProfileEnvProjectionPriorities(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"LITELLM_MAX_OUTPUT_TOKENS": "777"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayMaxOutputTokens != 2048 {
		t.Fatalf("maxOutputTokens = %d, want the MAX_TOKENS schema default", cfg.LLMGatewayMaxOutputTokens)
	}

	cfg, err = loadWith(t, map[string]string{"LITELLM_MAX_RETRIES": "9"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayMaxRetries != 3 {
		t.Fatalf("maxRetries = %d, want the RETRY_ATTEMPTS schema default", cfg.LLMGatewayMaxRetries)
	}

	cfg, err = loadWith(t, map[string]string{
		"LITELLM_API_URL":         "http://primary:1",
		"LITELLM_API_BASE":        "http://secondary:2",
		"LITELLM_MAX_TOKENS":      "4096",
		"LITELLM_RETRY_ATTEMPTS":  "5",
		"LITELLM_TEMPERATURE":     "1.25",
		"LITELLM_TOP_P":           "0.25",
		"LITELLM_MODEL":           "openai/gpt-4o",
		"LITELLM_FALLBACK_MODELS": " a , ,b, a ",
		"NODE_ENV":                "production",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LiteLLMAPIBase != "http://primary:1" {
		t.Fatalf("apiBase = %q, want LITELLM_API_URL to win", cfg.LiteLLMAPIBase)
	}
	if cfg.LLMGatewayMaxOutputTokens != 4096 || cfg.LLMGatewayMaxRetries != 5 {
		t.Fatalf("maxima = %d/%d", cfg.LLMGatewayMaxOutputTokens, cfg.LLMGatewayMaxRetries)
	}
	if cfg.LLMGatewayTemperature != 1.25 || cfg.LLMGatewayTopP != 0.25 {
		t.Fatalf("sampling = %v/%v", cfg.LLMGatewayTemperature, cfg.LLMGatewayTopP)
	}
	if cfg.LLMGatewayModel != "openai/gpt-4o" {
		t.Fatalf("model = %q", cfg.LLMGatewayModel)
	}
	if strings.Join(cfg.LLMGatewayFallbackModels, ",") != "a,b,a" {
		t.Fatalf("fallbackModels = %v", cfg.LLMGatewayFallbackModels)
	}
	if !cfg.NodeEnvProduction {
		t.Fatal("NODE_ENV=production must be reported")
	}
}
