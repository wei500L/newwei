package accountdata

import "encoding/json"

// The export format identity and version are the constants of
// user-data-export.service.ts.
const (
	exportFormat  = "wei.user-data-export.v1"
	exportVersion = 1
)

// sectionsKeys is Object.keys(sections) in the NestJS declaration order. The
// audit metadata and the document body must both use it.
var sectionsKeys = []string{
	"account",
	"membership",
	"userSettings",
	"contentSubscriptions",
	"newsBehavior",
	"digest",
	"analysisWorkspace",
	"notifications",
	"assistantRuns",
}

// recordCount is the recordCounts object of the audit metadata (8 counters).
type recordCount struct {
	UserSettings           int `json:"userSettings"`
	ContentSubscriptions   int `json:"contentSubscriptions"`
	NewsBehaviorAggregates int `json:"newsBehaviorAggregates"`
	SavedViews             int `json:"savedViews"`
	AnalysisThreads        int `json:"analysisThreads"`
	AnalysisComments       int `json:"analysisComments"`
	Notifications          int `json:"notifications"`
	AssistantRuns          int `json:"assistantRuns"`
}

// exportAccount mirrors the user.findUnique select of loadAccount. Every field
// appears in the selected order; nullable dates are ISO strings or JSON null.
type exportAccount struct {
	ID            string               `json:"id"`
	Email         string               `json:"email"`
	EmailVerified *string              `json:"emailVerified"`
	PendingEmail  *string              `json:"pendingEmail"`
	FirstName     string               `json:"firstName"`
	LastName      string               `json:"lastName"`
	AvatarURL     *string              `json:"avatarUrl"`
	IsActive      bool                 `json:"isActive"`
	LastLoginAt   *string              `json:"lastLoginAt"`
	CreatedAt     *string              `json:"createdAt"`
	UpdatedAt     *string              `json:"updatedAt"`
	TotpFactor    *exportTotpFactor    `json:"totpFactor"`
	RecoveryCodes []exportRecoveryCode `json:"recoveryCodes"`
}

// exportTotpFactor mirrors the totpFactor select.
type exportTotpFactor struct {
	Label      *string `json:"label"`
	EnrolledAt *string `json:"enrolledAt"`
	VerifiedAt *string `json:"verifiedAt"`
	DisabledAt *string `json:"disabledAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  *string `json:"createdAt"`
	UpdatedAt  *string `json:"updatedAt"`
}

// exportRecoveryCode mirrors the recoveryCodes select (createdAt asc).
type exportRecoveryCode struct {
	UsedAt    *string `json:"usedAt"`
	CreatedAt *string `json:"createdAt"`
}

// exportMembership mirrors the membership.findUnique include.
type exportMembership struct {
	ID        string                 `json:"id"`
	UserID    string                 `json:"userId"`
	OrgID     string                 `json:"orgId"`
	RoleID    string                 `json:"roleId"`
	IsActive  bool                   `json:"isActive"`
	CreatedAt *string                `json:"createdAt"`
	Org       *exportMembershipOrg   `json:"org"`
	Role      *exportRole            `json:"role"`
	Roles     []exportMembershipRole `json:"roles"`
}

// exportMembershipOrg mirrors the nested org select.
type exportMembershipOrg struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Slug               string  `json:"slug"`
	Description        *string `json:"description"`
	PlanTier           *string `json:"planTier"`
	SubscriptionStatus *string `json:"subscriptionStatus"`
	IsActive           bool    `json:"isActive"`
	CreatedAt          *string `json:"createdAt"`
	UpdatedAt          *string `json:"updatedAt"`
}

// exportRole mirrors the nested role select, including the permissions join
// ordered by permission.name asc.
type exportRole struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description *string                `json:"description"`
	IsSystem    bool                   `json:"isSystem"`
	Permissions []exportRolePermission `json:"permissions"`
}

// exportRolePermission is one `{ permission: { name, description } }` wrapper.
type exportRolePermission struct {
	Permission exportPermission `json:"permission"`
}

// exportPermission is the nested permission select.
type exportPermission struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

// exportMembershipRole mirrors the membership.roles include (role.name asc).
type exportMembershipRole struct {
	RoleID    string     `json:"roleId"`
	CreatedAt *string    `json:"createdAt"`
	Role      exportRole `json:"role"`
}

// exportUserSetting mirrors the userSetting.findMany select (key asc).
type exportUserSetting struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	CreatedAt *string         `json:"createdAt"`
	UpdatedAt *string         `json:"updatedAt"`
}

// exportContentSubscription mirrors the userContentSubscription select
// (kind asc, displayValue asc).
type exportContentSubscription struct {
	ID              string          `json:"id"`
	Kind            string          `json:"kind"`
	NormalizedValue string          `json:"normalizedValue"`
	DisplayValue    string          `json:"displayValue"`
	TaxonomyPath    *string         `json:"taxonomyPath"`
	TaxonomyVersion *string         `json:"taxonomyVersion"`
	Source          string          `json:"source"`
	Metadata        json.RawMessage `json:"metadata"`
	CreatedAt       *string         `json:"createdAt"`
	UpdatedAt       *string         `json:"updatedAt"`
}

// exportNewsBehavior mirrors the newsBehavior section.
type exportNewsBehavior struct {
	Profile            json.RawMessage           `json:"profile"`
	Aggregates         []exportBehaviorAggregate `json:"aggregates"`
	SimilaritySnapshot *exportSimilaritySnapshot `json:"similaritySnapshot"`
}

// exportBehaviorAggregate mirrors the userNewsBehaviorAggregate select
// (signalType asc, signalKey asc).
type exportBehaviorAggregate struct {
	SignalType       string  `json:"signalType"`
	SignalKey        string  `json:"signalKey"`
	Score            float64 `json:"score"`
	LastInteractedAt *string `json:"lastInteractedAt"`
	CreatedAt        *string `json:"createdAt"`
	UpdatedAt        *string `json:"updatedAt"`
}

// exportSimilaritySnapshot mirrors the userNewsSimilaritySnapshot select.
type exportSimilaritySnapshot struct {
	Dirty      bool    `json:"dirty"`
	ComputedAt *string `json:"computedAt"`
	CreatedAt  *string `json:"createdAt"`
	UpdatedAt  *string `json:"updatedAt"`
}

// exportDigest mirrors the digest section.
type exportDigest struct {
	DeliverySchedule *exportDeliverySchedule `json:"deliverySchedule"`
}

// exportDeliverySchedule mirrors the userDigestDeliverySchedule select.
type exportDeliverySchedule struct {
	Enabled      bool    `json:"enabled"`
	Timezone     string  `json:"timezone"`
	SendHour     int     `json:"sendHour"`
	SendMinute   int     `json:"sendMinute"`
	NextRunAt    *string `json:"nextRunAt"`
	LastSentAt   *string `json:"lastSentAt"`
	LastStatus   string  `json:"lastStatus"`
	LastStatusAt *string `json:"lastStatusAt"`
	LastError    *string `json:"lastError"`
	CreatedAt    *string `json:"createdAt"`
	UpdatedAt    *string `json:"updatedAt"`
}

// exportSavedView mirrors the savedAnalysisView select
// (updatedAt desc, createdAt desc).
type exportSavedView struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description *string         `json:"description"`
	Surface     string          `json:"surface"`
	RoutePath   string          `json:"routePath"`
	QueryState  json.RawMessage `json:"queryState"`
	Visibility  string          `json:"visibility"`
	CreatedAt   *string         `json:"createdAt"`
	UpdatedAt   *string         `json:"updatedAt"`
}

// exportAnalysisThread mirrors the analysisThread select
// (updatedAt desc, createdAt desc).
type exportAnalysisThread struct {
	ID           string  `json:"id"`
	SubjectType  string  `json:"subjectType"`
	SubjectID    string  `json:"subjectId"`
	NoteMarkdown *string `json:"noteMarkdown"`
	CreatedAt    *string `json:"createdAt"`
	UpdatedAt    *string `json:"updatedAt"`
}

// exportAnalysisComment mirrors the analysisComment select (createdAt asc).
type exportAnalysisComment struct {
	ID           string  `json:"id"`
	ThreadID     string  `json:"threadId"`
	BodyMarkdown string  `json:"bodyMarkdown"`
	CreatedAt    *string `json:"createdAt"`
	UpdatedAt    *string `json:"updatedAt"`
}

// exportNotification mirrors the notification select (createdAt desc).
type exportNotification struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	Body      *string         `json:"body"`
	Data      json.RawMessage `json:"data"`
	ReadAt    *string         `json:"readAt"`
	CreatedAt *string         `json:"createdAt"`
	UpdatedAt *string         `json:"updatedAt"`
}

// AssistantRun is one mapped AssistantRun document. The pointer fields with
// omitempty reproduce the mapped object's `undefined` semantics (the key is
// absent), while the pointer fields without omitempty reproduce `?? null`.
type AssistantRun struct {
	ID             *string         `json:"id"`
	OrgID          *string         `json:"orgId,omitempty"`
	Type           *string         `json:"type,omitempty"`
	ConversationID *string         `json:"conversationId"`
	Status         *string         `json:"status,omitempty"`
	Input          json.RawMessage `json:"input"`
	Output         json.RawMessage `json:"output"`
	Summary        *string         `json:"summary"`
	Error          *string         `json:"error"`
	Model          *string         `json:"model"`
	TriggeredByID  *string         `json:"triggeredById"`
	CreatedAt      *string         `json:"createdAt"`
	UpdatedAt      *string         `json:"updatedAt"`
}

// exportPayload is the full document shape. The streaming writer emits the same
// members in the same order; the type is used by the byte-equivalence test as
// the one-shot reference.
type exportPayload struct {
	Format     string         `json:"format"`
	Version    int            `json:"version"`
	ExportedAt string         `json:"exportedAt"`
	Subject    exportSubject  `json:"subject"`
	Sections   exportSections `json:"sections"`
}

// exportSubject is the subject object.
type exportSubject struct {
	UserID string `json:"userId"`
	OrgID  string `json:"orgId"`
}

// exportSections is the full sections object in declaration order.
type exportSections struct {
	Account              *exportAccount              `json:"account"`
	Membership           *exportMembership           `json:"membership"`
	UserSettings         []exportUserSetting         `json:"userSettings"`
	ContentSubscriptions []exportContentSubscription `json:"contentSubscriptions"`
	NewsBehavior         exportNewsBehavior          `json:"newsBehavior"`
	Digest               exportDigest                `json:"digest"`
	AnalysisWorkspace    exportAnalysisWorkspace     `json:"analysisWorkspace"`
	Notifications        []exportNotification        `json:"notifications"`
	AssistantRuns        []AssistantRun              `json:"assistantRuns"`
}

// exportAnalysisWorkspace is the nested analysisWorkspace object.
type exportAnalysisWorkspace struct {
	SavedViews []exportSavedView       `json:"savedViews"`
	Threads    []exportAnalysisThread  `json:"threads"`
	Comments   []exportAnalysisComment `json:"comments"`
}
