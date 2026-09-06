// DATABASE_URL（Prisma 风格 mysql:// URL）→ go-sql-driver/mysql DSN 解析。
//
// 处理：URL 编码的用户名/密码、host/port、database 名、UTF-8、UTC
// （parseTime=true, loc=UTC——DATETIME(3) 无时区，按 UTC 解释，毫秒精度
// 由 driver 原样保留）。解析失败返回错误；错误信息只含结构信息
// （scheme/host 缺失等），不含 DSN 原文（凭据不进日志/差分正文）。
package usersettings

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// OpenMySQLFromURL 解析 mysql://user:password@host:port/database 形态的
// DATABASE_URL 并打开连接池（惰性连接——启动时不触库）。
func OpenMySQLFromURL(databaseURL string) (*sql.DB, error) {
	cfg, err := parseMySQLURL(databaseURL)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("mysql open failed: %w", err)
	}
	return db, nil
}

// parseMySQLURL 把 Prisma 风格 mysql URL 转换为 driver 配置。
func parseMySQLURL(databaseURL string) (mysql.Config, error) {
	var cfg mysql.Config
	trimmed := strings.TrimSpace(databaseURL)
	if trimmed == "" {
		return cfg, errors.New("DATABASE_URL is empty")
	}

	scheme := trimmed
	if idx := strings.Index(trimmed, "://"); idx >= 0 {
		scheme = trimmed[:idx]
	}
	switch scheme {
	case "mysql":
	case "mysql+prisma": // Prisma 部署形态，等价 mysql
	default:
		return cfg, fmt.Errorf("unsupported DATABASE_URL scheme %q (want mysql)", scheme)
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return cfg, errors.New("DATABASE_URL is not a valid URL")
	}
	if parsed.Host == "" {
		return cfg, errors.New("DATABASE_URL has no host")
	}

	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		port = "3306"
	}
	cfg.Net = "tcp"
	cfg.Addr = host + ":" + port

	if parsed.User != nil {
		cfg.User = parsed.User.Username()
		cfg.Passwd, _ = parsed.User.Password()
	}

	dbName := strings.TrimPrefix(parsed.Path, "/")
	if dbName == "" {
		return cfg, errors.New("DATABASE_URL has no database name")
	}
	cfg.DBName = dbName

	// 查询参数（charset 等）忽略——下方显式设置 UTF-8 与时区语义，
	// 避免依赖调用方拼对参数。
	cfg.Params = map[string]string{
		"charset": "utf8mb4",
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Collation = "utf8mb4_unicode_ci"

	return cfg, nil
}
