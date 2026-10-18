package orgaccesswrite

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// This file is the narrow, exported organization-bootstrap port the identity
// onboarding batch uses when a platform administrator approves a
// new-organization registration application.
//
// It deliberately exposes one operation instead of the GraphQL service: the
// approval path must create the organization, the three default roles, their
// permissions, the approver's administrator membership and the original
// org/create audit row in the same transaction, and it must invalidate
// org:active:list:v1 afterwards. Duplicating that transaction in another package
// would be the surest way to drift from the mutation. The port is not a
// feature-switch gate: callers may use it even when
// API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE stays legacy, because it invokes a
// business helper rather than the GraphQL root.

// CreateOrgParams is one bootstrap request. Name and slug are normalized by the
// shared implementation exactly like CreateOrgInput.
type CreateOrgParams struct {
	ActorID     string
	Name        string
	Slug        string
	Description *string
}

// CreatedOrg is the created organization's identity. The approval path only
// needs these three values: the invite is reloaded from MySQL with its
// relations, and the response is the application scalar.
type CreatedOrg struct {
	ID   string
	Name string
	Slug string
}

// OrgBootstrap reuses the shared MySQL pool and Redis client. It holds no
// request state and opens no second connection.
type OrgBootstrap struct {
	db    *sql.DB
	redis *redis.Client
}

// NewOrgBootstrap wires the port onto the shared connections.
func NewOrgBootstrap(db *sql.DB, redisClient *redis.Client) *OrgBootstrap {
	return &OrgBootstrap{db: db, redis: redisClient}
}

// CreateOrg runs the shared organization bootstrap as actorID.
func (b *OrgBootstrap) CreateOrg(ctx context.Context, params CreateOrgParams) (CreatedOrg, error) {
	if b == nil || b.db == nil {
		return CreatedOrg{}, errDatabaseUnavailable
	}
	svc := &service{db: b.db, redis: b.redis}
	org, err := svc.createOrgForActor(ctx, params.ActorID, params.Name, params.Slug, params.Description)
	if err != nil {
		return CreatedOrg{}, err
	}
	return CreatedOrg{ID: org.ID, Name: org.Name, Slug: org.Slug}, nil
}

// StatusOf maps an error raised by CreateOrg onto the HTTP status and message
// the NestJS GlobalExceptionFilter would produce for the same failure. Only the
// status matters to the caller; an unknown error stays a 500.
func StatusOf(err error) (int, string) {
	if err == nil {
		return http.StatusOK, ""
	}
	var input *inputFailure
	if errors.As(err, &input) {
		return http.StatusBadRequest, input.message
	}
	var failure *serviceFailure
	if errors.As(err, &failure) {
		return failure.status, failure.message
	}
	status, message := rbacapi.StatusOf(err)
	return status, message
}
