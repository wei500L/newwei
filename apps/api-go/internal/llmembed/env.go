package llmembed

import (
	"os"
	"strconv"
	"strings"
)

type gatewayDefaults struct {
	APIBase       string
	TimeoutMs     int
	MaxRetries    int
	EncryptionKey string
}

// gatewayEnv 读取 Nest 已有的 LITELLM_* 与 SYSTEM_SETTINGS_ENCRYPTION_KEY。
// profile 缺 apiBase、超时或重试时才回落。凭据明文不来自新的环境变量。
func gatewayEnv() gatewayDefaults {
	apiBase := strings.TrimSpace(os.Getenv("LITELLM_API_URL"))
	if apiBase == "" {
		apiBase = strings.TrimSpace(os.Getenv("LITELLM_API_BASE"))
	}
	if apiBase == "" {
		apiBase = "http://localhost:4001"
	}
	timeoutMs := 60_000
	if raw := strings.TrimSpace(os.Getenv("LITELLM_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			timeoutMs = value
		}
	}
	retries := 3
	raw := strings.TrimSpace(os.Getenv("LITELLM_RETRY_ATTEMPTS"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("LITELLM_MAX_RETRIES"))
	}
	if raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			retries = value
		}
	}
	return gatewayDefaults{
		APIBase:       apiBase,
		TimeoutMs:     timeoutMs,
		MaxRetries:    retries,
		EncryptionKey: strings.TrimSpace(os.Getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY")),
	}
}
