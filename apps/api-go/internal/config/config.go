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
}

// Load 从 getenv 读取并校验配置。
func Load(getenv func(string) string) (Config, error) {
	var errs []string

	port := defaultPort
	if raw := strings.TrimSpace(getenv("PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PORT must be a positive integer, got %q", raw))
		} else {
			port = value
		}
	}

	legacy := strings.TrimSpace(getenv("LEGACY_API_URL"))
	if legacy == "" {
		legacy = defaultLegacy
	}
	parsed, err := url.ParseRequestURI(legacy)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		errs = append(errs, fmt.Sprintf("LEGACY_API_URL must be an absolute URL, got %q", legacy))
	}

	if len(errs) > 0 {
		return Config{}, errors.New(strings.Join(errs, "; "))
	}
	return Config{Port: port, LegacyAPIURL: legacy}, nil
}

// LoadFromOS 是生产入口的便捷封装。
func LoadFromOS() (Config, error) {
	return Load(os.Getenv)
}

// ReadTimeoutSec 导出给 main 组装 http.Server 使用。
func ReadTimeoutSec() int { return readTimeoutSec }
