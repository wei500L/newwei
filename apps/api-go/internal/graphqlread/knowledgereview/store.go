package knowledgereview

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// permissionSettingsManage and permissionKnowledgeGraphReview are the two
// permissions the NestJS @Permissions("settings.manage", "knowledgegraph.review")
// decorator accepts. The mutation is authorized when the caller holds either
// one.
const (
	permissionSettingsManage       = "settings.manage"
	permissionKnowledgeGraphReview = "knowledgegraph.review"
)

// errDatabaseUnavailable reports a missing MySQL handle.
var errDatabaseUnavailable = errors.New("knowledgereview: mysql is not configured")

// Options configures Register.
type Options struct {
	// Now overrides the server clock. It exists for tests and must stay nil in
	// production.
	Now func() time.Time
}

// service holds the write backends: MySQL for the graph transaction and the
// audit trail, Redis for the shared settings cache and the graph cache
// invalidation.
type service struct {
	db       *sql.DB
	redis    *redis.Client
	settings *knowledgegraph.ReviewSettingsReader
	reviews  *settingscrawl.EvidenceReviewReader
	now      func() time.Time
}

// Register adds the reviewKnowledgeGraphEvidence mutation.
//
// It registers no object type on purpose: the result projects the shared
// knowledge-graph evidence review models, whose registration must happen
// exactly once. The caller registers them through
// settingscrawl.Register or settingscrawl.RegisterReviewModelTypes and then
// calls Register here.
func Register(reg *contract.Registry, db *sql.DB, redisClient *redis.Client, options Options) {
	if reg == nil {
		panic("graphqlread: knowledgereview.Register requires a registry")
	}
	svc := &service{
		db:       db,
		redis:    redisClient,
		settings: knowledgegraph.NewReviewSettingsReader(db, redisClient),
		reviews:  settingscrawl.NewEvidenceReviewReader(db, redisClient),
		now:      options.Now,
	}
	reg.RegisterMutation(contract.Root{
		Name:           "reviewKnowledgeGraphEvidence",
		AnyPermissions: []string{permissionSettingsManage, permissionKnowledgeGraphReview},
		Resolve:        contract.Bind(svc.reviewKnowledgeGraphEvidenceResolver),
	})
}

// RegisteredMutations lists the mutation names Register adds. The startup log
// uses it.
var RegisteredMutations = []string{"reviewKnowledgeGraphEvidence"}

// clock returns the injectable clock.
func (s *service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

// callContext guards against a nil call context.
func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

// inputFailure is the class-validator / BadRequestException equivalent. Its
// message is joined the same way GlobalExceptionFilter joins the
// ValidationPipe array.
type inputFailure struct{ message string }

func (e *inputFailure) Error() string { return e.message }

func newInputFailure(message string) error { return &inputFailure{message: message} }

// serviceFailure is an HttpException equivalent with an explicit status.
type serviceFailure struct {
	status  int
	message string
}

func (e *serviceFailure) Error() string { return e.message }

// evidenceNotFoundError is the NestJS NotFoundException raised when the id does
// not resolve inside the caller's organization. A legally deleted relation
// later returns null, which is a different outcome.
func evidenceNotFoundError() error {
	return &serviceFailure{status: http.StatusNotFound, message: "Knowledge graph evidence not found"}
}

// invalidRelationError is the NestJS BadRequestException raised when a
// corrected relation cannot be normalized.
func invalidRelationError() error {
	return &serviceFailure{status: http.StatusBadRequest, message: "Invalid corrected knowledge graph relation"}
}

// graphqlFailure converts a business error to the GraphQL field failure shape.
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
	return &contract.Failure{Message: err.Error(), Status: http.StatusInternalServerError}
}

// ---- small helpers ----

// newRowID writes a Prisma cuid column ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// timestamp returns the clock truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes and the ISO UTC millisecond audit field.
func (s *service) timestamp() time.Time {
	return s.clock().UTC().Truncate(time.Millisecond)
}

// appendUnique appends value unless it is already present, preserving insertion
// order (the JS Set semantics of touchedEdgeIds).
func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

// logCacheFailure records a best-effort cache invalidation failure. The review
// result is still returned, exactly like the NestJS cache wrapper.
func logCacheFailure(prefix string, err error) {
	log.Printf("knowledgereview: failed to invalidate cache prefix %q: %v", prefix, err)
}
