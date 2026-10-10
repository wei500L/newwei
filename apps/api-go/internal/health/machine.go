package health

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type humanAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

type machineRecord struct {
	ID        string
	ExpiresAt sql.NullTime
	RevokedAt sql.NullTime
	OrgActive bool
}

type machineStore interface {
	Find(ctx context.Context, tokenHash string) (machineRecord, bool, error)
	Touch(ctx context.Context, id string, at time.Time) error
}

// Gate 只服务 GET /api/healthz。人类令牌走现有验签链且不要求业务权限。
// mtk_ 机器令牌单独查 MachineAccessToken，不会因此得到 dashboards.read。
type Gate struct {
	humans   humanAuth
	machines machineStore
	now      func() time.Time
}

func (g Gate) Open(w http.ResponseWriter, r *http.Request) bool {
	header := r.Header.Get("Authorization")
	if strings.HasPrefix(header, "Bearer ") {
		token := strings.TrimSpace(header[len("Bearer "):])
		if strings.HasPrefix(token, "mtk_") {
			return g.allowMachine(w, r, token)
		}
	}
	if g.humans == nil {
		authhttp.WriteUnauthorized(w, r, "")
		return false
	}
	return g.humans.Authenticate(w, r) != nil
}

func (g Gate) allowMachine(w http.ResponseWriter, r *http.Request, token string) bool {
	if g.machines == nil {
		authhttp.WriteUnauthorized(w, r, "Invalid machine token")
		return false
	}
	sum := sha256.Sum256([]byte(token))
	record, ok, err := g.machines.Find(r.Context(), hex.EncodeToString(sum[:]))
	if err != nil {
		log.Printf("healthz: machine token lookup failed")
		authhttp.WriteDatabaseFailure(w, r)
		return false
	}
	now := time.Now()
	if g.now != nil {
		now = g.now()
	}
	if !ok || record.RevokedAt.Valid || (record.ExpiresAt.Valid && !record.ExpiresAt.Time.After(now)) || !record.OrgActive {
		authhttp.WriteUnauthorized(w, r, "Invalid machine token")
		return false
	}
	if err := g.machines.Touch(r.Context(), record.ID, now); err != nil {
		log.Printf("healthz: machine token lastUsedAt update failed")
	}
	return true
}

type mysqlMachines struct {
	db *sql.DB
}

func (s mysqlMachines) Find(ctx context.Context, tokenHash string) (machineRecord, bool, error) {
	if s.db == nil {
		return machineRecord{}, false, sql.ErrConnDone
	}
	var record machineRecord
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
INNER JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?
LIMIT 1`, tokenHash).Scan(&record.ID, &record.ExpiresAt, &record.RevokedAt, &active)
	if err == sql.ErrNoRows {
		return machineRecord{}, false, nil
	}
	if err != nil {
		return machineRecord{}, false, err
	}
	record.OrgActive = active == 1
	return record, true, nil
}

func (s mysqlMachines) Touch(ctx context.Context, id string, at time.Time) error {
	if s.db == nil {
		return sql.ErrConnDone
	}
	_, err := s.db.ExecContext(ctx, "UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?", at.UTC(), id)
	return err
}
