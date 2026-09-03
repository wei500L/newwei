// Package config 加载 api-go 网关的环境变量。
//
// api-go 是 Strangler Fig 网关：默认把全部流量反向代理到 NestJS（LEGACY_API_URL），
// 已迁移路由逐步切到 Go 原生 handler（legacy → shadow → canary → go 四态）。
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
	defaultPort    = 4020
	defaultLegacy  = "http://localhost:4000"
	readTimeoutSec = 30
)

// Config 是网关运行所需的全部配置。
type Config struct {
	Port         int
	LegacyAPIURL string // NestJS apps/api 的基址（含协议，不含路径）

	// shadow 差分执行的资源边界（防放大攻击/雪崩）。请求体与响应捕获是
	// 两个独立预算——请求体决定「差分能否重放请求」，响应捕获决定
	// 「差分能否拿到完整 legacy 响应」；两者任一超限只丢弃差分，不影响
	// 主响应。
	ShadowTimeoutMs              int   // 单次 Go 侧执行的硬超时
	ShadowMaxRequestBodyByte     int64 // 差分可重放的请求体上限
	ShadowMaxResponseCaptureByte int64 // 响应差分缓存上限（超过即停捕获，主响应继续流式透传）
	ShadowMaxInflight            int   // 并发中的 shadow 执行数上限，超出直接丢弃
	ShadowMaxPerMin              int   // 每分钟 shadow 执行预算（令牌桶），超出丢弃

	// 差分日志正文：默认只记录响应体 hash 与差异字段，不保存业务正文
	//（避免把业务数据写进网关日志）。显式开启 debug 后才记录截断正文。
	ShadowDebugBodyLog         bool
	ShadowDebugBodyLogMaxBytes int64

	// canary 分流：
	CanaryPercent int // 0=legacy 等价；100=go 等价；中间按 orgId 稳定哈希分流
}

// Load 从 getenv 读取并校验配置。
func Load(getenv func(string) string) (Config, error) {
	var errs []string

	cfg := Config{
		// 资源边界的默认值：足够完成一次真实 handler 执行与小型 JSON
		// 响应捕获，同时把单次失误的代价限制在秒级/兆级以内。
		ShadowTimeoutMs:              2_000,
		ShadowMaxRequestBodyByte:     1 << 20, // 1 MiB
		ShadowMaxResponseCaptureByte: 1 << 20, // 1 MiB
		ShadowMaxInflight:            16,
		ShadowMaxPerMin:              600,
		ShadowDebugBodyLog:           false,
		ShadowDebugBodyLogMaxBytes:   2_048,
		CanaryPercent:                0,
	}

	port := defaultPort
	if raw := strings.TrimSpace(getenv("PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PORT must be a positive integer, got %q", raw))
		} else {
			port = value
		}
	}
	cfg.Port = port

	legacy := strings.TrimSpace(getenv("LEGACY_API_URL"))
	if legacy == "" {
		legacy = defaultLegacy
	}
	parsed, err := url.ParseRequestURI(legacy)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		errs = append(errs, fmt.Sprintf("LEGACY_API_URL must be an absolute URL, got %q", legacy))
	}
	cfg.LegacyAPIURL = legacy

	if raw := strings.TrimSpace(getenv("SHADOW_TIMEOUT_MS")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_TIMEOUT_MS must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowTimeoutMs = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_REQUEST_BODY_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_REQUEST_BODY_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxRequestBodyByte = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_RESPONSE_CAPTURE_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_RESPONSE_CAPTURE_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxResponseCaptureByte = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_INFLIGHT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_INFLIGHT must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxInflight = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_PER_MINUTE")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_PER_MINUTE must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxPerMin = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_DEBUG_BODY_LOG")); raw != "" {
		switch strings.ToLower(raw) {
		case "1", "true", "yes", "on":
			cfg.ShadowDebugBodyLog = true
		case "0", "false", "no", "off":
			cfg.ShadowDebugBodyLog = false
		default:
			errs = append(errs, fmt.Sprintf("SHADOW_DEBUG_BODY_LOG must be a boolean, got %q", raw))
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_DEBUG_BODY_LOG_MAX_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_DEBUG_BODY_LOG_MAX_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowDebugBodyLogMaxBytes = value
		}
	}

	if raw := strings.TrimSpace(getenv("CANARY_PERCENT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 || value > 100 {
			errs = append(errs, fmt.Sprintf("CANARY_PERCENT must be an integer in [0,100], got %q", raw))
		} else {
			cfg.CanaryPercent = value
		}
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

// ReadTimeoutSec 导出给 main 组装 http.Server 使用。
func ReadTimeoutSec() int { return readTimeoutSec }
