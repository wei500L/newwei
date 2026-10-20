package config

import "testing"

func TestCrawlFrontierLlmWorkerMode(t *testing.T) {
	deps := map[string]string{
		"DATABASE_URL":                   "mysql://u:p@h:3306/db",
		"REDIS_HOST":                     "h",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY": "0000000000000000000000000000000000000000000000000000000000000000",
	}
	cases := []struct {
		name      string
		mode      string
		extraEnv  map[string]string
		wantMode  string
		wantError bool
	}{
		{"empty is legacy", "", nil, "legacy", false},
		{"legacy accepted", "legacy", nil, "legacy", false},
		{"go accepted with deps", "go", deps, "go", false},
		{"go without deps fails", "go", nil, "", true},
		{"go without encryption key fails", "go", map[string]string{
			"DATABASE_URL": deps["DATABASE_URL"], "REDIS_HOST": deps["REDIS_HOST"],
		}, "", true},
		{"go without redis fails", "go", map[string]string{
			"DATABASE_URL": deps["DATABASE_URL"], "SYSTEM_SETTINGS_ENCRYPTION_KEY": deps["SYSTEM_SETTINGS_ENCRYPTION_KEY"],
		}, "", true},
		{"invalid value rejected", "shadow", nil, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := Load(func(key string) string {
				if value, ok := tc.extraEnv[key]; ok {
					return value
				}
				if key == "API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE" {
					return tc.mode
				}
				return ""
			})
			if tc.wantError {
				if err == nil {
					t.Fatalf("want error, got cfg %+v", cfg)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if string(cfg.CrawlFrontierLlmWorkerMode) != tc.wantMode {
				t.Errorf("CrawlFrontierLlmWorkerMode = %q, want %q", cfg.CrawlFrontierLlmWorkerMode, tc.wantMode)
			}
		})
	}
}
