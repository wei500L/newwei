package config

import (
	"strings"
	"testing"
)

// TestQualityOpsModesRejectInvalidValues locks the three switch contracts: only
// "", "legacy" and "go" are accepted, and the error names the variable.
func TestQualityOpsModesRejectInvalidValues(t *testing.T) {
	cases := map[string]string{
		"API_GO_CLASSIFICATION_REPORTS_MODE":        "API_GO_CLASSIFICATION_REPORTS_MODE must be one of legacy|go",
		"API_GO_CLASSIFICATION_QUALITY_WORKER_MODE": "API_GO_CLASSIFICATION_QUALITY_WORKER_MODE must be one of legacy|go",
		"API_GO_PIPELINE_RECOVERY_MODE":             "API_GO_PIPELINE_RECOVERY_MODE must be one of legacy|go",
	}
	for key, want := range cases {
		_, err := Load(func(name string) string {
			if name == key {
				return "sometimes"
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s invalid mode error = %v", key, err)
		}
	}
}

// TestQualityOpsModesDefaultToLegacy locks the default of every switch, including
// the empty-string spelling.
func TestQualityOpsModesDefaultToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClassificationReportsMode != ClassificationReportsModeLegacy ||
		cfg.ClassificationQualityWorkerMode != ClassificationQualityWorkerModeLegacy ||
		cfg.PipelineRecoveryMode != PipelineRecoveryModeLegacy {
		t.Fatalf("defaults = %q/%q/%q",
			cfg.ClassificationReportsMode,
			cfg.ClassificationQualityWorkerMode,
			cfg.PipelineRecoveryMode)
	}
}

// TestClassificationReportsGoRequiresFullStack verifies the credentialed
// requirements of the report creation takeover.
func TestClassificationReportsGoRequiresFullStack(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CLASSIFICATION_REPORTS_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("go without credentials must fail")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_CLASSIFICATION_REPORTS_MODE=go",
		"DATABASE_URL is required when API_GO_CLASSIFICATION_REPORTS_MODE=go",
		"REDIS_HOST is required when API_GO_CLASSIFICATION_REPORTS_MODE=go",
		"MONGO_URI is required when API_GO_CLASSIFICATION_REPORTS_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %v does not contain %q", err, want)
		}
	}
}

// TestClassificationQualityWorkerGoNeedsNoJWT locks the worker requirements: it
// consumes the shared queue and never authenticates a caller.
func TestClassificationQualityWorkerGoNeedsNoJWT(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_QUALITY_WORKER_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClassificationQualityWorkerMode != ClassificationQualityWorkerModeGo {
		t.Fatalf("worker mode = %q", cfg.ClassificationQualityWorkerMode)
	}
	if cfg.ClassificationReportsMode != ClassificationReportsModeLegacy {
		t.Fatalf("reports mode = %q, want legacy", cfg.ClassificationReportsMode)
	}

	_, err = Load(func(key string) string {
		if key == "API_GO_CLASSIFICATION_QUALITY_WORKER_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("worker go without its resources must fail")
	}
	for _, want := range []string{
		"DATABASE_URL is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go",
		"REDIS_HOST is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go",
		"MONGO_URI is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %v does not contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "JWT_SECRET is required") {
		t.Fatalf("worker mode must not require JWT_SECRET: %v", err)
	}
}

// TestPipelineRecoveryGoNeedsJWTMySQLAndMongo verifies the runs read requirements
// and that Redis is not one of them.
func TestPipelineRecoveryGoNeedsJWTMySQLAndMongo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_PIPELINE_RECOVERY_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PipelineRecoveryMode != PipelineRecoveryModeGo {
		t.Fatalf("pipeline recovery mode = %q", cfg.PipelineRecoveryMode)
	}

	_, err = Load(func(key string) string {
		if key == "API_GO_PIPELINE_RECOVERY_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("pipeline recovery go without its resources must fail")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_PIPELINE_RECOVERY_MODE=go",
		"DATABASE_URL is required when API_GO_PIPELINE_RECOVERY_MODE=go",
		"MONGO_URI is required when API_GO_PIPELINE_RECOVERY_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %v does not contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "REDIS_HOST is required") {
		t.Fatalf("pipeline recovery must not require REDIS_HOST: %v", err)
	}
}

// TestQualityWorkerConcurrency locks max(1, min(4, configured)) with 2 unset.
func TestQualityWorkerConcurrency(t *testing.T) {
	cases := map[int]int{0: 2, 1: 1, 2: 2, 3: 3, 4: 4, 8: 4, 64: 4}
	for configured, want := range cases {
		cfg := Config{NewsProcessQueueConcurrency: configured}
		if got := cfg.QualityWorkerConcurrency(); got != want {
			t.Fatalf("configured=%d concurrency=%d, want %d", configured, got, want)
		}
	}
}

// TestNewsProcessQueueConcurrencyParsing locks the positive-integer validation.
func TestNewsProcessQueueConcurrencyParsing(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "NEWS_PROCESS_QUEUE_CONCURRENCY" {
			return "3"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsProcessQueueConcurrency != 3 || cfg.QualityWorkerConcurrency() != 3 {
		t.Fatalf("configured = %d", cfg.NewsProcessQueueConcurrency)
	}

	for _, invalid := range []string{"0", "-1", "many"} {
		_, err := Load(func(key string) string {
			if key == "NEWS_PROCESS_QUEUE_CONCURRENCY" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "NEWS_PROCESS_QUEUE_CONCURRENCY must be a positive integer") {
			t.Fatalf("value %q error = %v", invalid, err)
		}
	}
}
