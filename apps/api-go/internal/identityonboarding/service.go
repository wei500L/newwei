package identityonboarding

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// MailSender is the narrow mail port this batch needs. The concrete
// implementation is authlogin.MailSender, which wraps the real SMTP transport;
// the interface keeps the service free of transport concerns and lets tests
// assert the delivery boundary.
type MailSender interface {
	Send(ctx context.Context, message authlogin.MailMessage) error
}

// Config is the small runtime configuration of the unit.
type Config struct {
	// BaseURL is NEXTAUTH_URL (defaulted to http://localhost:3000 by config).
	// The invitation link is built exactly like new URL('/invite/<token>', base).
	BaseURL string
}

// Service holds the shared connections and the reused ports. It opens no second
// MySQL pool, no Redis client and no HTTP client.
type Service struct {
	db      *sql.DB
	redis   *redis.Client
	mail    MailSender
	rbac    *rbacapi.Service
	orgs    *orgaccesswrite.OrgBootstrap
	baseURL string
}

// NewService wires the unit onto the shared resources.
func NewService(db *sql.DB, redisClient *redis.Client, mail MailSender, cfg Config) *Service {
	return &Service{
		db:      db,
		redis:   redisClient,
		mail:    mail,
		rbac:    rbacapi.NewService(db, redisClient),
		orgs:    orgaccesswrite.NewOrgBootstrap(db, redisClient),
		baseURL: cfg.BaseURL,
	}
}

// inviteTTLDays is INVITE_TTL_DAYS.
const inviteTTLDays = 7

// createInviteInput is the normalized create-invite request.
type createInviteInput struct {
	Email         string
	FirstName     *string
	LastName      *string
	PrimaryRoleID string
	RoleIDs       []string
}

// issueInvite builds the pending invitation row and returns the raw token that
// only the email may carry. The database keeps the SHA-256 hash alone.
func (s *Service) issueInvite(orgID, actorID string, input createInviteInput, roleIDs []string, now time.Time) (inviteRecord, string, error) {
	inviteID, err := newRowID()
	if err != nil {
		return inviteRecord{}, "", err
	}
	rawToken, tokenHash, err := newInviteToken()
	if err != nil {
		return inviteRecord{}, "", err
	}
	roleIDsJSON, err := json.Marshal(roleIDs)
	if err != nil {
		return inviteRecord{}, "", err
	}
	record := inviteRecord{
		ID:            inviteID,
		OrgID:         orgID,
		Email:         input.Email,
		FirstName:     trimmedName(input.FirstName),
		LastName:      trimmedName(input.LastName),
		PrimaryRoleID: input.PrimaryRoleID,
		RoleIDs:       roleIDsJSON,
		InvitedByID:   stringPtr(actorID),
		TokenHash:     tokenHash,
		Status:        inviteStatusPending,
		ExpiresAt:     now.Add(inviteTTLDays * 24 * time.Hour),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	return record, rawToken, nil
}

// trimmedName mirrors `value?.trim() || null`.
func trimmedName(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// inviteURL builds the link the same way new URL('/invite/<token>', base) does:
// an absolute path replaces the base path, query and fragment.
func (s *Service) inviteURL(rawToken string) (string, error) {
	base := s.baseURL
	if strings.TrimSpace(base) == "" {
		base = "http://localhost:3000"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("identityonboarding: invalid base URL")
	}
	parsed.Path = "/invite/" + rawToken
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// sendInviteEmail delivers the invitation through the real SMTP transport. A
// delivery failure is returned to the caller: the database row stays (the write
// happened first), and the response is a failure rather than a false success.
func (s *Service) sendInviteEmail(ctx context.Context, relations inviteWithRelations, rawToken string) error {
	if s.mail == nil {
		return fmt.Errorf("identityonboarding: mail sender is not configured")
	}
	inviteURL, err := s.inviteURL(rawToken)
	if err != nil {
		return err
	}
	return s.mail.Send(ctx, authlogin.MailMessage{
		To:      relations.invite.Email,
		Subject: "Invitation to join " + relations.org.Name,
		Text: "You have been invited to join " + relations.org.Name + " as " + relations.role.Name +
			". Accept the invite here: " + inviteURL,
		HTML: "<p>You have been invited to join <strong>" + relations.org.Name + "</strong> as <strong>" +
			relations.role.Name + "</strong>.</p><p><a href=\"" + inviteURL + "\">" + inviteURL + "</a></p>",
	})
}

// cacheProfileOrgKey mirrors `profile:${userId}:${orgId ?? "default"}`.
func cacheProfileOrgKey(userID, orgID string) string {
	if orgID == "" {
		orgID = "default"
	}
	return "profile:" + userID + ":" + orgID
}

// invalidateProfileCache drops the cached profile of a user in the default
// context and in every organization they belong to. This is the functional fix
// of this batch: an existing account that joins an organization or has its roles
// replaced must not keep seeing the previous permission set from /me. Redis
// failures are logged and never replay the already committed membership.
func (s *Service) invalidateProfileCache(ctx context.Context, userID, orgID string) {
	if s.redis == nil || userID == "" {
		return
	}
	_ = s.redis.Del(ctx, cacheProfileOrgKey(userID, ""), cacheProfileOrgKey(userID, orgID)).Err()
	rows, err := s.db.QueryContext(ctx, "SELECT `orgId` FROM `Membership` WHERE `userId` = ?", userID)
	if err != nil {
		log.Printf("identityonboarding: profile cache invalidation failed: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var memberOrgID string
		if err := rows.Scan(&memberOrgID); err != nil {
			log.Printf("identityonboarding: profile cache invalidation failed: %v", err)
			return
		}
		_ = s.redis.Del(ctx, cacheProfileOrgKey(userID, memberOrgID)).Err()
	}
	if err := rows.Err(); err != nil {
		log.Printf("identityonboarding: profile cache invalidation failed: %v", err)
	}
}

// hashLoginPassword is an indirection over accountsecurity.HashLoginPassword so
// the Node-compatible cost-10 bcrypt implementation stays single-sourced.
func hashLoginPassword(password string) (string, error) {
	return accountsecurity.HashLoginPassword(password)
}
