package workspace

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

var (
	// errDatabaseUnavailable reports a missing MySQL handle. The executor
	// maps it to the standard internal error response.
	errDatabaseUnavailable = errors.New("mysql is not configured")
	// errMongoUnavailable reports a missing Mongo handle.
	errMongoUnavailable = errors.New("mongo is not configured")
)

// service holds the three read-only backends. now is overridable in tests.
type service struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
	now   func() time.Time
}

func (s *service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *service) call(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

// internalFailure is the GraphQL internal error shape used when a backend
// handle is missing or a query fails unexpectedly.
func internalFailure() error {
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}

// jsTrim mirrors String.prototype.trim: ASCII whitespace plus U+FEFF and the
// Unicode space separators. MySQL and JavaScript both trim these before the
// stored value is compared, so GraphQL inputs must be normalized the same way.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

func stringPtr(value string) *string {
	return &value
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return stringPtr(value.String)
}

func nullTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	stamp := value.Time.UTC()
	return &stamp
}

func utcTime(value time.Time) time.Time {
	return value.UTC()
}

// safeIDPattern accepts every identifier the schema mints: cuid, CUID2, and
// 24-char hex ObjectIds. Any other value means the id did not come from the
// database and the IN list must not be rendered.
var safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// sqlIDList renders ids as an already-validated SQL literal list. It returns
// false when the list is empty or any id contains a character outside the
// identifier alphabet, so a caller can never splice untrusted input into SQL.
func sqlIDList(ids []string) (string, bool) {
	if len(ids) == 0 {
		return "", false
	}
	quoted := make([]string, 0, len(ids))
	for _, id := range ids {
		if !safeIDPattern.MatchString(id) {
			return "", false
		}
		quoted = append(quoted, "'"+id+"'")
	}
	return strings.Join(quoted, ","), true
}

// uniqueStrings keeps the first occurrence order, matching a JavaScript Set.
func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
