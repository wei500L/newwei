// Package mysqldb builds the shared MySQL connection pool from the
// Prisma-style DATABASE_URL used across api-go.
//
// The URL contract is fixed so every unit opens the same pool shape:
//   - schemes mysql and mysql+prisma are accepted;
//   - a missing port defaults to 3306;
//   - URL query parameters are ignored;
//   - charset=utf8mb4, ParseTime, Loc=UTC and utf8mb4_unicode_ci are pinned.
//
// The pool is bounded by the caller-supplied PoolConfig so a burst of
// authenticated requests and background workers cannot open an unbounded number
// of MySQL connections.
package mysqldb

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// PoolConfig bounds one connection pool. A non-positive bound leaves the
// database/sql default for that setting in place.
type PoolConfig struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

// Open parses databaseURL into a MySQL driver config and returns a lazily
// connected pool with the given bounds. sql.Open never dials, so an unreachable
// host surfaces on the first query rather than at wiring time.
func Open(databaseURL string, pool PoolConfig) (*sql.DB, error) {
	cfg, err := parseMySQLURL(databaseURL)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("mysql open failed: %w", err)
	}
	if pool.MaxOpenConns > 0 {
		db.SetMaxOpenConns(pool.MaxOpenConns)
	}
	if pool.MaxIdleConns > 0 {
		db.SetMaxIdleConns(pool.MaxIdleConns)
	}
	if pool.ConnMaxLifetime > 0 {
		db.SetConnMaxLifetime(pool.ConnMaxLifetime)
	}
	return db, nil
}

// parseMySQLURL converts a Prisma-style mysql URL into a driver configuration.
// Credentials come from the parsed userinfo, so a percent-encoded password is
// decoded exactly once. Error messages describe the structure only; the DSN
// text and its credentials never reach a log line.
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
	case "mysql+prisma": // Prisma deployment form, equivalent to mysql.
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

	// The URL's own query parameters are ignored on purpose: the charset and
	// time semantics below are the whole contract, so callers cannot accidentally
	// drop ParseTime or change the collation.
	cfg.Params = map[string]string{
		"charset": "utf8mb4",
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Collation = "utf8mb4_unicode_ci"

	return cfg, nil
}
