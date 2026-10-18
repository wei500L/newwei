// Package workspacewrite serves the migrated workspace GraphQL mutations:
// markNotificationRead, markAllNotificationsRead, upsertDashboard,
// deleteDashboard, createAlertChannel, updateAlertChannel, deleteAlertChannel,
// and updateAlertEventStatus.
//
// Register adds the eight Mutation roots and no Query root. The returned
// notification, dashboard and alert models are the same Go types the read
// packages register, so the caller registers those model sets exactly once
// (through workspace.RegisterModels, alerts.RegisterModels and
// history.RegisterModels) when the matching read switches are legacy.
//
// The takeover needs JWT verification, MySQL and Redis only: it reads no Mongo
// collection, starts no worker and never sends an email or a webhook.
package workspacewrite

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// errDatabaseUnavailable reports a missing MySQL handle. The executor maps it
// to the standard internal error response.
var errDatabaseUnavailable = errors.New("mysql is not configured")

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

func notFound(message string) error {
	return &serviceFailure{status: http.StatusNotFound, message: message}
}

func conflict(message string) error {
	return &serviceFailure{status: http.StatusConflict, message: message}
}

// graphqlFailure converts a write error to the GraphQL field failure shape.
// A plain error (an unexpected database failure, or one of the branches where
// NestJS raises an ordinary Error) stays a plain error, so the executor emits
// the same 500/INTERNAL_SERVER_ERROR response the NestJS exception filter does.
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
	return err
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

// nowMillis is the timestamp written to a DATETIME(3) column. The connection
// pool is pinned to UTC with millisecond precision, so truncating to the
// millisecond matches Prisma's own updatedAt/createdAt values.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// callContext guards against a nil call context.
func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
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

// jsonText renders a JSON column value as the text parameter of
// CAST(? AS JSON). An absent or JSON-null leaf becomes an empty object, which
// is the `value ?? {}` default the NestJS services apply before writing.
func jsonText(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "{}", nil
	}
	if !json.Valid(trimmed) {
		return "", errors.New("workspacewrite: invalid json value")
	}
	return string(trimmed), nil
}

// jsonScalar converts a nullable MySQL JSON column into the JSON scalar the
// projection layer expects. An empty column and a literal JSON null both become
// nil, which projects as GraphQL null instead of a quoted empty string.
func jsonScalar(raw []byte) *json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	message := json.RawMessage(append([]byte(nil), trimmed...))
	return &message
}

// placeholders renders a comma-separated list of count placeholders for an IN
// clause whose values are always followed, in order, through the arguments.
func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	var builder strings.Builder
	builder.Grow(count * 2)
	for index := 0; index < count; index++ {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteByte('?')
	}
	return builder.String()
}
