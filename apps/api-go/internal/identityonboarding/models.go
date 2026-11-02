package identityonboarding

import (
	"encoding/json"
	"time"
)

// This file holds the response and row projections. Every response type is a
// named struct: no business value travels through map[string]any. The shapes
// follow the Prisma model plus the exact include set of the NestJS handler, so
// an invitation list carries only primaryRole, a create/resend carries org and
// primaryRole, and a revoke carries the invite scalars alone.

// timestamp serializes as the JSON Date.toISOString() body Prisma returns.
type timestamp struct {
	time.Time
}

// MarshalJSON writes the millisecond UTC form NestJS clients already parse.
func (t timestamp) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func stamp(value time.Time) timestamp { return timestamp{Time: value} }

func stampPtr(value *time.Time) *timestamp {
	if value == nil {
		return nil
	}
	stamped := stamp(*value)
	return &stamped
}

// ---- organization ----

type orgRecord struct {
	ID                 string
	Name               string
	Slug               string
	Description        *string
	PlanTier           *string
	SubscriptionStatus *string
	IsActive           bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// orgView is the Org scalar projection used wherever Prisma `include: { org:
// true }` appears.
type orgView struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Slug               string    `json:"slug"`
	Description        *string   `json:"description"`
	PlanTier           *string   `json:"planTier"`
	SubscriptionStatus *string   `json:"subscriptionStatus"`
	IsActive           bool      `json:"isActive"`
	CreatedAt          timestamp `json:"createdAt"`
	UpdatedAt          timestamp `json:"updatedAt"`
}

func (o orgRecord) view() orgView {
	return orgView{
		ID:                 o.ID,
		Name:               o.Name,
		Slug:               o.Slug,
		Description:        o.Description,
		PlanTier:           o.PlanTier,
		SubscriptionStatus: o.SubscriptionStatus,
		IsActive:           o.IsActive,
		CreatedAt:          stamp(o.CreatedAt),
		UpdatedAt:          stamp(o.UpdatedAt),
	}
}

// ---- role ----

type roleRecord struct {
	ID          string
	Name        string
	Description *string
	IsSystem    bool
	OrgID       string
}

// roleView is the Role scalar projection (no permissions), matching
// `include: { primaryRole: true }`.
type roleView struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	IsSystem    bool    `json:"isSystem"`
	OrgID       string  `json:"orgId"`
}

func (r roleRecord) view() roleView {
	return roleView{ID: r.ID, Name: r.Name, Description: r.Description, IsSystem: r.IsSystem, OrgID: r.OrgID}
}

// ---- user ----

type userRecord struct {
	ID            string
	Email         string
	EmailVerified *time.Time
	PendingEmail  *string
	FirstName     string
	LastName      string
	AvatarURL     *string
	IsActive      bool
	LastLoginAt   *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// userView is the reviewedBy projection. It keeps every non-credential scalar
// and deliberately omits passwordHash: Prisma `include: { reviewedBy: true }`
// would leak the hash, so this response is narrowed and the difference is
// recorded in the delivery notes.
type userView struct {
	ID            string     `json:"id"`
	Email         string     `json:"email"`
	EmailVerified *timestamp `json:"emailVerified"`
	PendingEmail  *string    `json:"pendingEmail"`
	FirstName     string     `json:"firstName"`
	LastName      string     `json:"lastName"`
	AvatarURL     *string    `json:"avatarUrl"`
	IsActive      bool       `json:"isActive"`
	LastLoginAt   *timestamp `json:"lastLoginAt"`
	CreatedAt     timestamp  `json:"createdAt"`
	UpdatedAt     timestamp  `json:"updatedAt"`
}

func (u userRecord) view() *userView {
	return &userView{
		ID:            u.ID,
		Email:         u.Email,
		EmailVerified: stampPtr(u.EmailVerified),
		PendingEmail:  u.PendingEmail,
		FirstName:     u.FirstName,
		LastName:      u.LastName,
		AvatarURL:     u.AvatarURL,
		IsActive:      u.IsActive,
		LastLoginAt:   stampPtr(u.LastLoginAt),
		CreatedAt:     stamp(u.CreatedAt),
		UpdatedAt:     stamp(u.UpdatedAt),
	}
}

// ---- org invite ----

type inviteStatus string

const (
	inviteStatusPending  inviteStatus = "pending"
	inviteStatusAccepted inviteStatus = "accepted"
	inviteStatusRevoked  inviteStatus = "revoked"
)

type inviteRecord struct {
	ID            string
	OrgID         string
	Email         string
	FirstName     *string
	LastName      *string
	PrimaryRoleID string
	RoleIDs       json.RawMessage
	InvitedByID   *string
	AcceptedByID  *string
	TokenHash     string
	Status        inviteStatus
	ExpiresAt     time.Time
	AcceptedAt    *time.Time
	RevokedAt     *time.Time
	Metadata      json.RawMessage
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// inviteScalar is one OrgInvite model row.
type inviteScalar struct {
	ID            string          `json:"id"`
	OrgID         string          `json:"orgId"`
	Email         string          `json:"email"`
	FirstName     *string         `json:"firstName"`
	LastName      *string         `json:"lastName"`
	PrimaryRoleID string          `json:"primaryRoleId"`
	RoleIDs       json.RawMessage `json:"roleIds"`
	InvitedByID   *string         `json:"invitedById"`
	AcceptedByID  *string         `json:"acceptedById"`
	TokenHash     string          `json:"tokenHash"`
	Status        string          `json:"status"`
	ExpiresAt     timestamp       `json:"expiresAt"`
	AcceptedAt    *timestamp      `json:"acceptedAt"`
	RevokedAt     *timestamp      `json:"revokedAt"`
	Metadata      json.RawMessage `json:"metadata"`
	CreatedAt     timestamp       `json:"createdAt"`
	UpdatedAt     timestamp       `json:"updatedAt"`
}

func (i inviteRecord) scalar() inviteScalar {
	return inviteScalar{
		ID:            i.ID,
		OrgID:         i.OrgID,
		Email:         i.Email,
		FirstName:     i.FirstName,
		LastName:      i.LastName,
		PrimaryRoleID: i.PrimaryRoleID,
		RoleIDs:       i.RoleIDs,
		InvitedByID:   i.InvitedByID,
		AcceptedByID:  i.AcceptedByID,
		TokenHash:     i.TokenHash,
		Status:        string(i.Status),
		ExpiresAt:     stamp(i.ExpiresAt),
		AcceptedAt:    stampPtr(i.AcceptedAt),
		RevokedAt:     stampPtr(i.RevokedAt),
		Metadata:      i.Metadata,
		CreatedAt:     stamp(i.CreatedAt),
		UpdatedAt:     stamp(i.UpdatedAt),
	}
}

// inviteWithPrimaryRole is the GET /admin/invites list element.
type inviteWithPrimaryRole struct {
	inviteScalar
	PrimaryRole roleView `json:"primaryRole"`
}

// inviteWithOrgAndPrimaryRole is the create/resend response.
type inviteWithOrgAndPrimaryRole struct {
	inviteScalar
	Org         orgView  `json:"org"`
	PrimaryRole roleView `json:"primaryRole"`
}

// invitePreview is the public token preview. It never carries tokenHash.
type invitePreview struct {
	ID          string      `json:"id"`
	Email       string      `json:"email"`
	FirstName   *string     `json:"firstName"`
	LastName    *string     `json:"lastName"`
	Org         previewOrg  `json:"org"`
	PrimaryRole previewRole `json:"primaryRole"`
	ExpiresAt   timestamp   `json:"expiresAt"`
	Status      string      `json:"status"`
}

type previewOrg struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type previewRole struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ---- membership ----

type membershipRecord struct {
	ID        string
	UserID    string
	OrgID     string
	RoleID    string
	IsActive  bool
	CreatedAt time.Time
}

// membershipWithOrg is the accept response: membership scalars plus org. It
// never carries a session or a token.
type membershipWithOrg struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	OrgID     string    `json:"orgId"`
	RoleID    string    `json:"roleId"`
	IsActive  bool      `json:"isActive"`
	CreatedAt timestamp `json:"createdAt"`
	Org       orgView   `json:"org"`
}

// ---- registration application ----

type applicationType string

const (
	applicationTypeNewOrg  applicationType = "new_org"
	applicationTypeJoinOrg applicationType = "join_org"
)

type applicationStatus string

const (
	applicationStatusPending  applicationStatus = "pending"
	applicationStatusApproved applicationStatus = "approved"
	applicationStatusRejected applicationStatus = "rejected"
)

type applicationRecord struct {
	ID                   string
	Type                 applicationType
	Status               applicationStatus
	Email                string
	FirstName            string
	LastName             string
	OrgID                *string
	RequestedOrgName     *string
	RequestedOrgSlug     *string
	RequestedDescription *string
	DecisionReason       *string
	GeneratedInviteID    *string
	ReviewedByID         *string
	ReviewedAt           *time.Time
	Metadata             json.RawMessage
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type applicationScalar struct {
	ID                   string                `json:"id"`
	Type                 string                `json:"type"`
	Status               string                `json:"status"`
	Email                string                `json:"email"`
	FirstName            string                `json:"firstName"`
	LastName             string                `json:"lastName"`
	OrgID                *string               `json:"orgId"`
	RequestedOrgName     *string               `json:"requestedOrgName"`
	RequestedOrgSlug     *string               `json:"requestedOrgSlug"`
	RequestedDescription *string               `json:"requestedDescription"`
	DecisionReason       *string               `json:"decisionReason"`
	GeneratedInviteID    *string               `json:"generatedInviteId"`
	ReviewedByID         *string               `json:"reviewedById"`
	ReviewedAt           *timestamp            `json:"reviewedAt"`
	Metadata             json.RawMessage       `json:"metadata"`
	ApprovalProgress     *approvalProgressView `json:"approvalProgress,omitempty"`
	CreatedAt            timestamp             `json:"createdAt"`
	UpdatedAt            timestamp             `json:"updatedAt"`
}

func (a applicationRecord) scalar() applicationScalar {
	return applicationScalar{
		ID:                   a.ID,
		Type:                 string(a.Type),
		Status:               string(a.Status),
		Email:                a.Email,
		FirstName:            a.FirstName,
		LastName:             a.LastName,
		OrgID:                a.OrgID,
		RequestedOrgName:     a.RequestedOrgName,
		RequestedOrgSlug:     a.RequestedOrgSlug,
		RequestedDescription: a.RequestedDescription,
		DecisionReason:       a.DecisionReason,
		GeneratedInviteID:    a.GeneratedInviteID,
		ReviewedByID:         a.ReviewedByID,
		ReviewedAt:           stampPtr(a.ReviewedAt),
		Metadata:             a.Metadata,
		ApprovalProgress:     buildProgressView(a, nil),
		CreatedAt:            stamp(a.CreatedAt),
		UpdatedAt:            stamp(a.UpdatedAt),
	}
}

// applicationWithOrg is the reject-join response (and the org-join list
// element, which additionally carries reviewedBy).
type applicationWithOrg struct {
	applicationScalar
	Org *orgView `json:"org"`
}

// applicationWithReviewer is the platform list element: new_org rows carry no
// org relation in the NestJS include.
type applicationWithReviewer struct {
	applicationScalar
	ReviewedBy *userView `json:"reviewedBy"`
}

// applicationWithOrgAndReviewer is the approve-join response.
type applicationWithOrgAndReviewer struct {
	applicationScalar
	Org        *orgView  `json:"org"`
	ReviewedBy *userView `json:"reviewedBy"`
}

// applicationList is the GET /admin/registration-applications body. Both keys
// are always present; an unavailable side is an empty list.
type applicationList struct {
	OrgApplications      []applicationWithOrgAndReviewer `json:"orgApplications"`
	PlatformApplications []applicationWithReviewer       `json:"platformApplications"`
}
