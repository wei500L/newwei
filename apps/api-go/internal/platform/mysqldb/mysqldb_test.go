package mysqldb

import (
	"strings"
	"testing"
	"time"
)

func TestParseMySQLURL(t *testing.T) {
	cfg, err := parseMySQLURL("mysql://user:p%40ss@db.example:3307/app?charset=latin1")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.User != "user" || cfg.Passwd != "p@ss" {
		t.Fatalf("credentials = %q/%q", cfg.User, cfg.Passwd)
	}
	if cfg.Addr != "db.example:3307" || cfg.DBName != "app" {
		t.Fatalf("addr/db = %q/%q", cfg.Addr, cfg.DBName)
	}
	if !cfg.ParseTime || cfg.Loc != time.UTC || cfg.Collation != "utf8mb4_unicode_ci" || cfg.Params["charset"] != "utf8mb4" {
		t.Fatalf("pinned settings wrong: %+v", cfg)
	}

	// Port defaults to 3306 and the mysql+prisma alias is accepted.
	cfg, err = parseMySQLURL("mysql+prisma://root:secret@localhost/app")
	if err != nil {
		t.Fatalf("parse prisma: %v", err)
	}
	if cfg.Addr != "localhost:3306" {
		t.Fatalf("default port addr = %q", cfg.Addr)
	}
}

func TestParseMySQLURLRejectsInvalid(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		{"", "DATABASE_URL is empty"},
		{"postgres://user:secret@localhost/app", "unsupported DATABASE_URL scheme"},
		{"mysql:///app", "DATABASE_URL has no host"},
		{"mysql://user:secret@localhost", "DATABASE_URL has no database name"},
	}
	for _, tc := range cases {
		_, err := parseMySQLURL(tc.url)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%q: err = %v, want contains %q", tc.url, err, tc.want)
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatalf("%q: error leaked the password: %v", tc.url, err)
		}
	}
}

func TestOpenAppliesPoolBounds(t *testing.T) {
	db, err := Open("mysql://user:secret@localhost/app", PoolConfig{
		MaxOpenConns:    50,
		MaxIdleConns:    10,
		ConnMaxLifetime: 5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if got := db.Stats().MaxOpenConnections; got != 50 {
		t.Fatalf("MaxOpenConnections = %d, want 50", got)
	}
}
