package orgaccesswrite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// activeOrgListKey is the Redis key ActiveOrgRegistryService invalidates after
// an organization is created or toggled.
const activeOrgListKey = "org:active:list:v1"

// systemAdminRoleName is the reserved system administrator role name.
const systemAdminRoleName = "admin"

// slugPattern is the CreateOrgInput / UpdateOrgInput slug constraint. Go's
// regexp operates on code points for \p{L} and \p{N}, matching the JavaScript
// /u pattern.
var slugPattern = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$`)

var (
	// errDatabaseUnavailable reports a missing MySQL handle. The executor maps
	// it to the standard internal error response.
	errDatabaseUnavailable = errors.New("mysql is not configured")
	// errMirroredServerError reports a branch where NestJS would raise an
	// uncaught Prisma error, so the response is the production 500 shape.
	errMirroredServerError = errors.New("mirrored server error")
)

// dbtx is the query surface shared by *sql.DB and *sql.Tx.
type dbtx interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// inputFailure is the class-validator / BadRequestException equivalent. Its
// message joins the constraint messages with "; ", the same way
// GlobalExceptionFilter.getMessageFromResponse joins the ValidationPipe array.
type inputFailure struct{ message string }

func (e *inputFailure) Error() string { return e.message }

func newInputFailure(messages []string) error {
	return &inputFailure{message: strings.Join(messages, "; ")}
}

// serviceFailure is an HttpException equivalent with an explicit status.
type serviceFailure struct {
	status  int
	message string
}

func (e *serviceFailure) Error() string { return e.message }

func badRequest(message string) error {
	return &serviceFailure{status: http.StatusBadRequest, message: message}
}

func forbidden(message string) error {
	return &serviceFailure{status: http.StatusForbidden, message: message}
}

// graphqlFailure converts a write error to the GraphQL field failure shape.
// The organization path raises serviceFailure directly; the reused RBAC writes
// raise rbacapi errors, whose status and message come from rbacapi.StatusOf.
func graphqlFailure(err error) error {
	if err == nil {
		return nil
	}
	var input *inputFailure
	if errors.As(err, &input) {
		return &contract.Failure{Message: input.message, Status: http.StatusBadRequest}
	}
	var service *serviceFailure
	if errors.As(err, &service) {
		return &contract.Failure{Message: service.message, Status: service.status}
	}
	status, message := rbacapi.StatusOf(err)
	return &contract.Failure{Message: message, Status: status}
}

// uniqueConflict reports a MySQL duplicate-key error (1062), which Prisma
// surfaces as P2002.
func uniqueConflict(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

// newRowID writes a Prisma cuid column. MySQL has no client-side default, so
// the id must be supplied explicitly; the shape matches the existing Go
// batches (c followed by 24 hexadecimal digits).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// jsTrim mirrors String.prototype.trim: ASCII whitespace plus the Unicode
// space separators and the zero-width no-break space.
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

// jsMaxLengthLen mirrors the validator.js isLength used by class-validator
// MaxLength: the UTF-16 length minus the surrogate pairs and the presentation
// sequences (a non-variation-selector rune followed by U+FE0F or U+FE0E).
func jsMaxLengthLen(text string) int {
	runes := []rune(text)
	count := len(runes)
	for index := 0; index < len(runes); index++ {
		if isVariationSelectorRune(runes[index]) {
			continue
		}
		if index+1 < len(runes) && isVariationSelectorRune(runes[index+1]) {
			count--
			index++
		}
	}
	return count
}

func isVariationSelectorRune(value rune) bool {
	return value == 0xFE0F || value == 0xFE0E
}

// trimmedOptional mirrors `value?.trim() || undefined` (create) and
// `value?.trim() || null` (update): an absent, null, empty or whitespace-only
// value becomes SQL NULL.
func trimmedOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// sqlNullableString converts an optional string to its driver value.
func sqlNullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func boolValue(value bool) int {
	if value {
		return 1
	}
	return 0
}

// callContext guards against a nil call context.
func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}
