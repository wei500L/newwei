package config

import (
	"strings"
	"testing"
)

func baseAnalysisEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"JWT_SECRET":           "test-secret",
		"DATABASE_URL":         "mysql://root:secret@127.0.0.1:3306/app",
		"REDIS_HOST":           "127.0.0.1",
		"MONGO_URI":            "mongodb://127.0.0.1:27017/app",
		"ANALYSIS_MAX_RETRIES": "4",
	}
	for key, value := range overrides {
		values[key] = value
	}
	return func(key string) string { return values[key] }
}

func TestAnalysisRunsModeDefaultsToLegacyAndAcceptsGo(t *testing.T) {
	cfg, err := Load(baseAnalysisEnv(nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.AnalysisRunsMode != AnalysisRunsModeLegacy || cfg.AnalysisWorkerMode != AnalysisWorkerModeLegacy {
		t.Fatalf("default modes = %q/%q", cfg.AnalysisRunsMode, cfg.AnalysisWorkerMode)
	}
	if cfg.AnalysisMaxRetries != 4 || cfg.AnalysisQueueConcurrency != 2 {
		t.Fatalf("analysis defaults = retries %d concurrency %d", cfg.AnalysisMaxRetries, cfg.AnalysisQueueConcurrency)
	}
	goCfg, err := Load(baseAnalysisEnv(map[string]string{
		"API_GO_ANALYSIS_RUNS_MODE":   "go",
		"API_GO_ANALYSIS_WORKER_MODE": "go",
	}))
	if err != nil {
		t.Fatalf("go load: %v", err)
	}
	if goCfg.AnalysisRunsMode != AnalysisRunsModeGo || goCfg.AnalysisWorkerMode != AnalysisWorkerModeGo {
		t.Fatalf("go modes = %q/%q", goCfg.AnalysisRunsMode, goCfg.AnalysisWorkerMode)
	}
}

func TestAnalysisModesRejectInvalidValues(t *testing.T) {
	if _, err := Load(baseAnalysisEnv(map[string]string{"API_GO_ANALYSIS_RUNS_MODE": "yes"})); err == nil {
		t.Fatal("invalid runs mode should fail startup")
	}
	if _, err := Load(baseAnalysisEnv(map[string]string{"API_GO_ANALYSIS_WORKER_MODE": "nested"})); err == nil {
		t.Fatal("invalid worker mode should fail startup")
	}
}

func TestAnalysisRequirementSets(t *testing.T) {
	// The request mode needs JWT and Mongo.
	if _, err := Load(baseAnalysisEnv(map[string]string{
		"API_GO_ANALYSIS_RUNS_MODE": "go",
		"JWT_SECRET":                "",
	})); err == nil {
		t.Fatal("request mode without JWT should fail")
	}
	// The worker mode needs no JWT but needs the Redis subscription bus.
	if _, err := Load(baseAnalysisEnv(map[string]string{
		"API_GO_ANALYSIS_WORKER_MODE": "go",
		"JWT_SECRET":                  "",
		"GRAPHQL_SUBSCRIPTION_BUS":    "local",
	})); err == nil || !strings.Contains(err.Error(), "GRAPHQL_SUBSCRIPTION_BUS") {
		t.Fatalf("worker mode with local bus error = %v", err)
	}
	workerOnly, err := Load(baseAnalysisEnv(map[string]string{
		"API_GO_ANALYSIS_WORKER_MODE": "go",
		"JWT_SECRET":                  "",
	}))
	if err != nil {
		t.Fatalf("worker-only load: %v", err)
	}
	if workerOnly.AnalysisWorkerMode != AnalysisWorkerModeGo {
		t.Fatalf("worker mode = %q", workerOnly.AnalysisWorkerMode)
	}
	// A worker needs Mongo.
	if _, err := Load(baseAnalysisEnv(map[string]string{
		"API_GO_ANALYSIS_WORKER_MODE": "go",
		"MONGO_URI":                   "",
	})); err == nil {
		t.Fatal("worker mode without Mongo should fail")
	}
}

func TestAnalysisPromptEmptyStringIsConfigured(t *testing.T) {
	lookup := func(key string) (string, bool) {
		if key == "ANALYSIS_PROMPT_CORRELATION_SYSTEM" {
			return "", true
		}
		return "", false
	}
	cfg, err := load(baseAnalysisEnv(nil), lookup)
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
	cfg, err := Load(baseAnalysisEnv(map[string]string{
		"ANALYSIS_STREAM_FLUSH_CHARS": "0",
		"ANALYSIS_STREAM_FLUSH_MS":    "-5",
	}))
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
	cfg, err := Load(baseAnalysisEnv(nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.BullMQWorkersEnabled {
		t.Fatal("BULLMQ_WORKERS_ENABLED should default to true")
	}
	disabled, err := Load(baseAnalysisEnv(map[string]string{"BULLMQ_WORKERS_ENABLED": "false"}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if disabled.BullMQWorkersEnabled {
		t.Fatal("BULLMQ_WORKERS_ENABLED=false was ignored")
	}
}
