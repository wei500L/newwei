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

	// 与 NestJS env schema 相同的默认值（apps/api/src/modules/config/
	// env.schema.ts：JWT_ISSUER / JWT_AUDIENCE 的 z.string().default）。
	defaultJWTIssuer   = "modular-monolith"
	defaultJWTAudience = "modular-monolith-clients"
	defaultRedisPort   = 6379
)

// OnboardingMode 是 onboarding GET 迁移单元的路由模式
//（API_GO_ONBOARDING_MODE——Go-批3A 引入）。
type OnboardingMode string

const (
	// OnboardingModeShadow 是默认值：onboarding GET 保持 Go-批2A/2B 的
	// shadow 语义（NestJS 响应 + Go 差分，legacy-approved 身份）——
	// 直接手工启动 api-go 的旧行为不变。
	OnboardingModeShadow OnboardingMode = "shadow"
	// OnboardingModeGo 是 Go-批3A 的真实接管：onboarding GET 由 Go 独立
	// 鉴权（JWT 验签 + Redis blacklist + MySQL RBAC）并全响应。仅在
	// pilot profile（compose）/ 远端 smoke 显式启用。
	OnboardingModeGo OnboardingMode = "go"
)

// UserSettingsReadMode 是 user-settings 六个只读 GET 的统一路由模式
//（API_GO_USER_SETTINGS_READ_MODE——Go-批3B 引入）。
type UserSettingsReadMode string

const (
	// UserSettingsReadModeShadow：6 个 GET 都由 NestJS 响应，Go 做真实
	// 旁路查询与差分（onboarding/rss/spacetime 是既有 shadow 语义；
	// war-map/newsnow/situation-monitor 在本模式下由 NestJS 响应 + Go
	// 差分——新三端点也作为 shadow 单元接线）。
	UserSettingsReadModeShadow UserSettingsReadMode = "shadow"
	// UserSettingsReadModeGo：6 个 GET 都由 Go 独立响应（JWT 验签 +
	// Redis blacklist + MySQL RBAC + 独立查库 + normalization）。
	UserSettingsReadModeGo UserSettingsReadMode = "go"
)

// Config 是网关运行所需的全部配置。
type Config struct {
	Port         int
	LegacyAPIURL string // NestJS apps/api 的基址（含协议，不含路径）

	// DatabaseURL 是 Prisma 同名环境变量（mysql://user:pass@host:port/db）。
	// 仅供 user-settings 只读 shadow（onboarding/rss-reader/spacetime-timeline
	// 三个 GET）的 MySQL 只读查询使用；为空时这些 shadow 单元跳过执行，
	// 网关照常启动并代理全部请求（非阻断）。
	// OnboardingMode=go 时必填（启动失败——Go 接管端点不能依赖缺失的
	// 数据库）。值本身不进入日志/healthz/错误文本。
	DatabaseURL string

	// OnboardingMode 见 OnboardingMode 常量（默认 shadow）。
	OnboardingMode OnboardingMode

	// UserSettingsReadMode 见 UserSettingsReadMode 常量。未设置（空）时
	// 保持既有行为：API_GO_ONBOARDING_MODE 继续控制 onboarding，RSS/
	// Spacetime 保持 Shadow，War Map/NewsNow/Situation Monitor 保持
	// Legacy（Go-批3B 之前的部署不变）。设置为 go 时六个 GET 统一由 Go
	// 接管（优先级高于 API_GO_ONBOARDING_MODE）。非法值启动失败。
	UserSettingsReadMode UserSettingsReadMode

	// JWT 是 NestJS access token 的验签配置（与 api 服务同一
	// JWT_SECRET/JWT_ISSUER/JWT_AUDIENCE）。OnboardingMode=go 时
	// JWTSecret 必填；issuer/audience 默认值与 NestJS env schema 一致。
	// Secret 不进入日志/healthz/错误文本。
	JWTSecret   string
	JWTIssuer   string
	JWTAudience string

	// Redis 是 access-token blacklist 所用 Redis（与 NestJS api 服务同一
	// 实例——Go 不建第二套撤销名单）。OnboardingMode=go 时 Host 必填；
	// Port 默认 6379、DB 默认 0、用户名/密码可选（镜像 NestJS env
	// schema 的可选语义）。凭据不进入日志/healthz/错误文本。
	RedisHost     string
	RedisPort     int
	RedisUsername string
	RedisPassword string
	RedisDB       int

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

	// 只读取原文，不做解析（解析在 usersettings.OpenMySQLFromURL，错误
	// 不阻断启动）。空值在 shadow 模式合法：数据库能力整体不启用；
	// OnboardingMode=go 时下方显式要求非空（启动失败）。
	cfg.DatabaseURL = strings.TrimSpace(getenv("DATABASE_URL"))

	// onboarding 迁移单元的路由模式：默认 shadow（手工启动的旧行为）；
	// 非法值启动失败（不静默降级）。
	switch strings.TrimSpace(getenv("API_GO_ONBOARDING_MODE")) {
	case "":
		cfg.OnboardingMode = OnboardingModeShadow
	case string(OnboardingModeShadow):
		cfg.OnboardingMode = OnboardingModeShadow
	case string(OnboardingModeGo):
		cfg.OnboardingMode = OnboardingModeGo
	default:
		errs = append(errs, "API_GO_ONBOARDING_MODE must be one of shadow|go")
	}

	// user-settings 六个只读 GET 的统一读模式（Go-批3B）：默认空 = 兼容
	//（API_GO_ONBOARDING_MODE 继续控制 onboarding，其余端点旧去向不变）；
	// 非法值启动失败。
	switch strings.TrimSpace(getenv("API_GO_USER_SETTINGS_READ_MODE")) {
	case "":
		cfg.UserSettingsReadMode = ""
	case string(UserSettingsReadModeShadow):
		cfg.UserSettingsReadMode = UserSettingsReadModeShadow
	case string(UserSettingsReadModeGo):
		cfg.UserSettingsReadMode = UserSettingsReadModeGo
	default:
		errs = append(errs, "API_GO_USER_SETTINGS_READ_MODE must be one of shadow|go")
	}

	// JWT 验签配置（issuer/audience 默认值与 NestJS env schema 一致——
	// 保证与同一套 env 部署的 api 服务行为等价）。
	cfg.JWTSecret = strings.TrimSpace(getenv("JWT_SECRET"))
	cfg.JWTIssuer = strings.TrimSpace(getenv("JWT_ISSUER"))
	if cfg.JWTIssuer == "" {
		cfg.JWTIssuer = defaultJWTIssuer
	}
	cfg.JWTAudience = strings.TrimSpace(getenv("JWT_AUDIENCE"))
	if cfg.JWTAudience == "" {
		cfg.JWTAudience = defaultJWTAudience
	}

	// Redis（blacklist）配置。Port/DB 有默认值；Username/Password 可空
	//（镜像 NestJS 的可选语义）。
	cfg.RedisHost = strings.TrimSpace(getenv("REDIS_HOST"))
	cfg.RedisPort = defaultRedisPort
	if raw := strings.TrimSpace(getenv("REDIS_PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 || value > 65535 {
			errs = append(errs, fmt.Sprintf("REDIS_PORT must be a valid port number, got %q", raw))
		} else {
			cfg.RedisPort = value
		}
	}
	cfg.RedisUsername = strings.TrimSpace(getenv("REDIS_USERNAME"))
	cfg.RedisPassword = strings.TrimSpace(getenv("REDIS_PASSWORD"))
	if raw := strings.TrimSpace(getenv("REDIS_DB")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			errs = append(errs, fmt.Sprintf("REDIS_DB must be a non-negative integer, got %q", raw))
		} else {
			cfg.RedisDB = value
		}
	}

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

	// Go 接管模式的依赖前置校验：不得在依赖缺失时启动一个必然失败的
	// 「Go 接管端点」——启动即失败，错误只指出缺失的配置项名，不打印值。
	// Go-批3B：UserSettingsReadMode=go 触发同一套前置（六个 GET 全部由
	// Go 独立鉴权响应）；API_GO_ONBOARDING_MODE=go 单独设置时沿用批3A
	// 的同一校验（两变量叠加时只校验一次——条件取或）。
	goTakeover := cfg.OnboardingMode == OnboardingModeGo ||
		cfg.UserSettingsReadMode == UserSettingsReadModeGo
	if goTakeover {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
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
