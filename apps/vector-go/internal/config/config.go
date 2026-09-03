// Package config 加载并校验 vector 服务的环境变量。
//
// 语义逐条对齐 apps/vector/src/modules/config/env.schema.ts（zod）：
//   - PORT：正整数，默认 4010
//   - VECTOR_INTERNAL_TOKEN：必填，≥8 字符；生产环境禁止 dev-token（fail-closed，
//     绝不内置默认值——该 token 保护向量库的任意读写）
//   - QDRANT_URL：合法 URL，默认 http://localhost:6333
//   - QDRANT_API_KEY：可选，空白视为未配置
//   - VECTOR_COLLECTION_PREFIX：非空，默认 processed_item_summary
//   - VECTOR_QDRANT_TIMEOUT_MS：正整数，默认 5000
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const (
	envDevelopment = "development"
	envTest        = "test"
	envProduction  = "production"

	defaultPort             = 4010
	defaultQdrantURL        = "http://localhost:6333"
	defaultCollectionPrefix = "processed_item_summary"
	defaultTimeoutMs        = 5000
	minInternalTokenLength  = 8
)

// Config 是 vector 服务运行所需的全部配置。
type Config struct {
	NodeEnv          string
	Port             int
	InternalToken    string
	QdrantURL        string
	QdrantAPIKey     string // 空串表示未配置
	QdrantTimeoutMs  int
	CollectionPrefix string
}

// Load 从 getenv（生产代码传 os.Getenv，测试注入假实现）读取并校验配置。
// 任何校验失败都返回错误并阻止启动——与 zod 在 bootstrap 前校验的行为一致。
func Load(getenv func(string) string) (Config, error) {
	var errs []string

	cfg := Config{
		NodeEnv: getenv("NODE_ENV"),
	}
	switch cfg.NodeEnv {
	case envDevelopment, envTest, envProduction:
	case "":
		cfg.NodeEnv = envDevelopment
	default:
		errs = append(errs, fmt.Sprintf("NODE_ENV must be one of development|test|production, got %q", cfg.NodeEnv))
	}

	var err error
	if cfg.Port, err = positiveIntEnv(getenv, "PORT", defaultPort); err != nil {
		errs = append(errs, err.Error())
	}

	cfg.InternalToken = getenv("VECTOR_INTERNAL_TOKEN")
	if len(cfg.InternalToken) < minInternalTokenLength {
		errs = append(errs, fmt.Sprintf("VECTOR_INTERNAL_TOKEN must be at least %d characters", minInternalTokenLength))
	} else if cfg.NodeEnv == envProduction && cfg.InternalToken == "dev-token" {
		errs = append(errs, "VECTOR_INTERNAL_TOKEN must be explicitly configured in production (dev-token is not allowed)")
	}

	cfg.QdrantURL = strings.TrimSpace(getenv("QDRANT_URL"))
	if cfg.QdrantURL == "" {
		cfg.QdrantURL = defaultQdrantURL
	}
	if _, err := url.ParseRequestURI(cfg.QdrantURL); err != nil {
		errs = append(errs, fmt.Sprintf("QDRANT_URL must be a valid URL, got %q", cfg.QdrantURL))
	}

	cfg.QdrantAPIKey = strings.TrimSpace(getenv("QDRANT_API_KEY"))

	cfg.CollectionPrefix = strings.TrimSpace(getenv("VECTOR_COLLECTION_PREFIX"))
	if cfg.CollectionPrefix == "" {
		cfg.CollectionPrefix = defaultCollectionPrefix
	}

	if cfg.QdrantTimeoutMs, err = positiveIntEnv(getenv, "VECTOR_QDRANT_TIMEOUT_MS", defaultTimeoutMs); err != nil {
		errs = append(errs, err.Error())
	}

	if len(errs) > 0 {
		return Config{}, errors.New(strings.Join(errs, "; "))
	}
	return cfg, nil
}

// LoadFromOS 是生产入口的便捷封装。
func LoadFromOS() (Config, error) {
	return Load(os.Getenv)
}

func positiveIntEnv(getenv func(string) string, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer, got %q", key, raw)
	}
	return value, nil
}
