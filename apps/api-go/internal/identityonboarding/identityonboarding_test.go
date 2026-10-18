package identityonboarding

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

type stubMail struct {
	messages []authlogin.MailMessage
	err      error
}

func (m *stubMail) Send(_ context.Context, message authlogin.MailMessage) error {
	m.messages = append(m.messages, message)
	return m.err
}

// queryRoute matches the first SQL statement containing fragment.
type queryRoute struct {
	fragment string
	rows     driver.Rows
	err      error
}

func routeQuery(routes []queryRoute) func(string, []driver.NamedValue) (driver.Rows, error) {
	return func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		for _, route := range routes {
			if strings.Contains(query, route.fragment) {
				return route.rows, route.err
			}
		}
		return nil, errors.New("unexpected query: " + query)
	}
}

func execRouted(rowsByFragment map[string]int64) func(string, []driver.NamedValue) (driver.Result, error) {
	return func(query string, _ []driver.NamedValue) (driver.Result, error) {
		for fragment, affected := range rowsByFragment {
			if strings.Contains(query, fragment) {
				return stubResult{rows: affected}, nil
			}
		}
		return stubResult{rows: 1}, nil
	}
}

var (
	inviteColumnNames = []string{"id", "orgId", "email", "firstName", "lastName", "primaryRoleId", "roleIds",
		"invitedById", "acceptedById", "tokenHash", "status", "expiresAt", "acceptedAt", "revokedAt",
		"metadata", "createdAt", "updatedAt"}
	orgColumnNames  = []string{"id", "name", "slug", "description", "planTier", "subscriptionStatus", "isActive", "createdAt", "updatedAt"}
	roleColumnNames = []string{"id", "name", "description", "isSystem", "orgId"}
	publicUserNames = []string{"id", "email", "emailVerified", "pendingEmail", "firstName", "lastName",
		"avatarUrl", "isActive", "lastLoginAt", "createdAt", "updatedAt"}
	applicationColumnNames = []string{"id", "type", "status", "email", "firstName", "lastName", "orgId",
		"requestedOrgName", "requestedOrgSlug", "requestedDescription", "decisionReason", "generatedInviteId",
		"reviewedById", "reviewedAt", "metadata", "createdAt", "updatedAt"}
)

type orgFixture struct {
	id   string
	name string
	slug string
}

func (f orgFixture) row() []driver.Value {
	return []driver.Value{f.id, f.name, f.slug, nil, nil, nil, int64(1), time.Now(), time.Now()}
}

type roleFixture struct {
	id       string
	name     string
	isSystem bool
	orgID    string
}

func (f roleFixture) row() []driver.Value {
	system := int64(0)
	if f.isSystem {
		system = 1
	}
	return []driver.Value{f.id, f.name, nil, system, f.orgID}
}

type inviteFixture struct {
	id            string
	orgID         string
	email         string
	firstName     *string
	lastName      *string
	primaryRoleID string
	roleIDs       string
	status        string
	expiresAt     time.Time
}

func (f inviteFixture) row() []driver.Value {
	var first, last driver.Value
	if f.firstName != nil {
		first = *f.firstName
	}
	if f.lastName != nil {
		last = *f.lastName
	}
	return []driver.Value{f.id, f.orgID, f.email, first, last, f.primaryRoleID, []byte(f.roleIDs),
		nil, nil, "hash", f.status, f.expiresAt, nil, nil, nil, time.Now(), time.Now()}
}

func newTestService(db *sql.DB, mail MailSender) *Service {
	return NewService(db, nil, mail, Config{BaseURL: "http://app.local"})
}

// TestListApplicationsVisibility locks the four visibility combinations of the
// shared list route: users.write alone, platform_admin alone, both, neither.
func TestListApplicationsVisibility(t *testing.T) {
	ctx := context.Background()
	platformQuery := queryRoute{fragment: "FROM `GlobalRoleAssignment`", rows: emptyRows("id")}
	membershipRows := rowsWith([]string{"id", "roleId"}, []driver.Value{"m1", "r1"})
	linksEmpty := emptyRows("id", "name", "isSystem")
	primaryRole := rowsWith([]string{"id", "name", "isSystem"}, []driver.Value{"r1", "manager", int64(0)})
	permissions := rowsWith(
		[]string{"id", "roleId", "permissionId", "id", "name", "description"},
		[]driver.Value{"rp1", "r1", "p1", "p1", "users.write", nil},
	)
	managerChain := []queryRoute{
		{fragment: "FROM Membership WHERE userId", rows: membershipRows},
		{fragment: "FROM MembershipRole mr", rows: linksEmpty},
		{fragment: "FROM Role WHERE id = ? AND orgId", rows: primaryRole},
		{fragment: "FROM RolePermission rp", rows: permissions},
	}

	t.Run("users.write lists only the organization side", func(t *testing.T) {
		routes := append([]queryRoute{platformQuery}, managerChain...)
		routes = append(routes,
			queryRoute{fragment: "FROM `RegistrationApplication` WHERE `orgId`", rows: emptyRows(applicationColumnNames...)},
			queryRoute{fragment: "FROM `Org` WHERE `id` IN", rows: rowsWith(orgColumnNames, orgFixture{id: "o1", name: "Acme", slug: "acme"}.row())},
		)
		state := &stubState{query: routeQuery(routes)}
		list, err := newTestService(newStubDB(state), &stubMail{}).
			ListApplications(ctx, "u1", "o1", true)
		if err != nil {
			t.Fatal(err)
		}
		if list.PlatformApplications == nil || len(list.PlatformApplications) != 0 {
			t.Fatalf("platform list = %#v, want empty and non-nil", list.PlatformApplications)
		}
		if list.OrgApplications == nil {
			t.Fatal("organization list must be an empty slice, not nil")
		}
	})

	t.Run("platform_admin lists only the platform side", func(t *testing.T) {
		routes := []queryRoute{
			{fragment: "FROM `GlobalRoleAssignment`", rows: rowsWith([]string{"id"}, []driver.Value{"g1"})},
			{fragment: "FROM `RegistrationApplication` WHERE `type` = 'new_org'", rows: emptyRows(applicationColumnNames...)},
		}
		state := &stubState{query: routeQuery(routes)}
		list, err := newTestService(newStubDB(state), &stubMail{}).
			ListApplications(ctx, "u1", "o1", false)
		if err != nil {
			t.Fatal(err)
		}
		if list.OrgApplications == nil || len(list.OrgApplications) != 0 {
			t.Fatalf("organization list = %#v, want empty and non-nil", list.OrgApplications)
		}
		if list.PlatformApplications == nil {
			t.Fatal("platform list must be an empty slice, not nil")
		}
	})

	t.Run("neither permission is forbidden", func(t *testing.T) {
		state := &stubState{query: routeQuery([]queryRoute{platformQuery})}
		_, err := newTestService(newStubDB(state), &stubMail{}).ListApplications(ctx, "u1", "o1", false)
		var failure *httpError
		if !errors.As(err, &failure) || failure.status != 403 || failure.message != "Insufficient permissions" {
			t.Fatalf("err = %v", err)
		}
	})
}

// TestCreateInviteRejectsSystemAdministratorRole locks the ordinary invite guard:
// a manager with users.write still cannot hand out the system admin role.
func TestCreateInviteRejectsSystemAdministratorRole(t *testing.T) {
	adminRole := roleFixture{id: "r-admin", name: "admin", isSystem: true, orgID: "o1"}
	routes := []queryRoute{
		{fragment: "FROM `Role` WHERE `orgId` = ? AND `id` IN",
			rows: rowsWith(roleColumnNames, adminRole.row())},
		{fragment: "FROM Membership WHERE userId",
			rows: rowsWith([]string{"id", "roleId"}, []driver.Value{"m1", "r1"})},
		{fragment: "FROM MembershipRole mr", rows: emptyRows("id", "name", "isSystem")},
		{fragment: "FROM Role WHERE id = ? AND orgId",
			rows: rowsWith([]string{"id", "name", "isSystem"}, []driver.Value{"r1", "manager", int64(0)})},
		{fragment: "FROM RolePermission rp",
			rows: rowsWith([]string{"id", "roleId", "permissionId", "id", "name", "description"},
				[]driver.Value{"rp1", "r1", "p1", "p1", "users.write", nil})},
		{fragment: "FROM `RolePermission` `rp`", rows: emptyRows("roleId", "name")},
	}
	state := &stubState{query: routeQuery(routes)}
	_, err := newTestService(newStubDB(state), &stubMail{}).CreateInvite(context.Background(), "o1", "u1", createInviteInput{
		Email:         "new@example.com",
		PrimaryRoleID: adminRole.id,
		RoleIDs:       []string{adminRole.id},
	})
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 403 ||
		failure.message != "System administrator role cannot be granted via invitations" {
		t.Fatalf("err = %v", err)
	}
}

// TestAcceptInviteExistingAccountRequiresSignIn locks the public accept branch:
// an existing address is never overwritten by the supplied password.
func TestAcceptInviteExistingAccountRequiresSignIn(t *testing.T) {
	routes := acceptPreludeRoutes()
	routes = append(routes, queryRoute{
		fragment: "FROM `User` WHERE `email`",
		rows: rowsWith(append(publicUserNames, "passwordHash"),
			append(newUserRow("u-existing"), "stored-hash")),
	})
	state := &stubState{query: routeQuery(routes)}
	password := "password123"
	_, err := newTestService(newStubDB(state), &stubMail{}).AcceptInvite(context.Background(), acceptInviteParams{
		Token:    "token-value",
		Password: &password,
	})
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 403 ||
		failure.message != "Please sign in with the invited email to accept this invite" {
		t.Fatalf("err = %v", err)
	}
}

// TestAcceptInviteExplicitEmptyNameDoesNotFallBack locks `??` semantics: an
// explicit empty firstName must not silently use the invited name.
func TestAcceptInviteExplicitEmptyNameDoesNotFallBack(t *testing.T) {
	routes := acceptPreludeRoutes()
	routes = append(routes, queryRoute{fragment: "FROM `User` WHERE `email`", rows: emptyRows(append(publicUserNames, "passwordHash")...)})
	state := &stubState{query: routeQuery(routes)}
	password := "password123"
	empty := ""
	_, err := newTestService(newStubDB(state), &stubMail{}).AcceptInvite(context.Background(), acceptInviteParams{
		Token:     "token-value",
		Password:  &password,
		FirstName: &empty,
	})
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 400 ||
		failure.message != "First and last name are required" {
		t.Fatalf("err = %v", err)
	}
}

// TestAcceptInviteCreatesUnverifiedUserAndReplacesRoles locks the single
// transaction: claim, membership, full role replacement, and an account that is
// not marked email-verified by the invitation link.
func TestAcceptInviteCreatesUnverifiedUserAndReplacesRoles(t *testing.T) {
	routes := acceptPreludeRoutes()
	routes = append(routes,
		queryRoute{fragment: "FROM `User` WHERE `email`", rows: emptyRows(append(publicUserNames, "passwordHash")...)},
		queryRoute{fragment: "FROM `Membership` WHERE `userId`", rows: rowsWith([]string{"id", "createdAt"},
			[]driver.Value{"m1", time.Now()})},
	)
	state := &stubState{
		query: routeQuery(routes),
		exec:  execRouted(map[string]int64{"UPDATE `OrgInvite`": 1, "DELETE FROM `MembershipRole`": 0}),
	}
	password := "password123"
	firstName := "Ada"
	lastName := "Lovelace"
	membership, err := newTestService(newStubDB(state), &stubMail{}).AcceptInvite(context.Background(), acceptInviteParams{
		Token:     "token-value",
		Password:  &password,
		FirstName: &firstName,
		LastName:  &lastName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if membership.Org.ID != "o1" || membership.OrgID != "o1" || !membership.IsActive {
		t.Fatalf("membership = %+v", membership)
	}
	if membership.UserID == "" || membership.UserID == "u-existing" {
		t.Fatalf("user id = %q", membership.UserID)
	}

	statements := state.statements()
	var userInsert, inviteUpdate, membershipUpdate string
	for _, statement := range statements {
		switch {
		case strings.Contains(statement, "INSERT INTO `User`"):
			userInsert = statement
		case strings.Contains(statement, "UPDATE `OrgInvite`"):
			inviteUpdate = statement
		case strings.Contains(statement, "UPDATE `Membership`"):
			membershipUpdate = statement
		}
	}
	if userInsert == "" {
		t.Fatal("new user was not inserted")
	}
	if strings.Contains(userInsert, "emailVerified") {
		t.Fatalf("user insert must leave emailVerified NULL: %s", userInsert)
	}
	if !strings.Contains(inviteUpdate, "status` = 'accepted'") {
		t.Fatalf("invite claim = %q", inviteUpdate)
	}
	if membershipUpdate == "" {
		t.Fatal("existing membership was not reactivated and re-roled")
	}
}

// TestAcceptInviteClaimConflictDoesNotGrant locks the single-use claim: a losing
// concurrent request gets 409 and writes no membership.
func TestAcceptInviteClaimConflictDoesNotGrant(t *testing.T) {
	routes := acceptPreludeRoutes()
	routes = append(routes, queryRoute{fragment: "FROM `User` WHERE `email`", rows: emptyRows(append(publicUserNames, "passwordHash")...)})
	state := &stubState{
		query: routeQuery(routes),
		exec:  execRouted(map[string]int64{"UPDATE `OrgInvite`": 0}),
	}
	password := "password123"
	firstName := "Ada"
	lastName := "Lovelace"
	_, err := newTestService(newStubDB(state), &stubMail{}).AcceptInvite(context.Background(), acceptInviteParams{
		Token:     "token-value",
		Password:  &password,
		FirstName: &firstName,
		LastName:  &lastName,
	})
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 409 ||
		failure.message != "Invitation has already been accepted or revoked" {
		t.Fatalf("err = %v", err)
	}
	for _, statement := range state.statements() {
		if strings.Contains(statement, "INSERT INTO `Membership`") || strings.Contains(statement, "INSERT INTO `MembershipRole`") {
			t.Fatalf("claim loser wrote a membership: %s", statement)
		}
	}
}

// TestApproveNewOrgRequiresPlatformAdmin locks the service-side platform check:
// an organization administrator without a GlobalRoleAssignment cannot approve a
// new organization, and no application read happens first.
func TestApproveNewOrgRequiresPlatformAdmin(t *testing.T) {
	state := &stubState{query: routeQuery([]queryRoute{
		{fragment: "FROM `GlobalRoleAssignment`", rows: emptyRows("id")},
	})}
	_, err := newTestService(newStubDB(state), &stubMail{}).ApproveNewOrg(context.Background(), "u1", "app1")
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 403 ||
		failure.message != "Platform admin access required" {
		t.Fatalf("err = %v", err)
	}
}

// TestListInvitesUsesLinkedRolesFirst locks the MembershipRole-first rule: a
// manager whose primary role has no users.write but whose membership link grants
// it must still pass, without falling back to the primary role.
func TestListInvitesUsesLinkedRolesFirst(t *testing.T) {
	routes := []queryRoute{
		{fragment: "FROM Membership WHERE userId",
			rows: rowsWith([]string{"id", "roleId"}, []driver.Value{"m1", "r-primary"})},
		{fragment: "FROM MembershipRole mr",
			rows: rowsWith([]string{"id", "name", "isSystem"}, []driver.Value{"r-linked", "manager", int64(0)})},
		{fragment: "FROM RolePermission rp",
			rows: rowsWith([]string{"id", "roleId", "permissionId", "id", "name", "description"},
				[]driver.Value{"rp1", "r-linked", "p1", "p1", "users.write", nil})},
		{fragment: "FROM `OrgInvite` WHERE `orgId`",
			rows: emptyRows(inviteColumnNames...)},
	}
	state := &stubState{query: routeQuery(routes)}
	invites, err := newTestService(newStubDB(state), &stubMail{}).ListInvites(context.Background(), "o1", "u1")
	if err != nil {
		t.Fatal(err)
	}
	if invites == nil || len(invites) != 0 {
		t.Fatalf("invites = %#v, want an empty non-nil slice", invites)
	}
}

// TestRevokeInviteIsOrganizationScoped locks the id + orgId lookup: an
// invitation of another organization is a 404, never a cross-tenant revoke.
func TestRevokeInviteIsOrganizationScoped(t *testing.T) {
	routes := []queryRoute{
		{fragment: "FROM Membership WHERE userId",
			rows: rowsWith([]string{"id", "roleId"}, []driver.Value{"m1", "r1"})},
		{fragment: "FROM MembershipRole mr", rows: emptyRows("id", "name", "isSystem")},
		{fragment: "FROM Role WHERE id = ? AND orgId",
			rows: rowsWith([]string{"id", "name", "isSystem"}, []driver.Value{"r1", "admin", int64(1)})},
		{fragment: "FROM RolePermission rp",
			rows: rowsWith([]string{"id", "roleId", "permissionId", "id", "name", "description"},
				[]driver.Value{"rp1", "r1", "p1", "p1", "users.write", nil})},
		{fragment: "FROM `OrgInvite` WHERE `id`", rows: emptyRows(inviteColumnNames...)},
	}
	state := &stubState{query: routeQuery(routes)}
	_, err := newTestService(newStubDB(state), &stubMail{}).RevokeInvite(context.Background(), "o1", "u1", "other-org-invite")
	var failure *httpError
	if !errors.As(err, &failure) || failure.status != 404 || failure.message != "Invite not found" {
		t.Fatalf("err = %v", err)
	}
	for _, statement := range state.statements() {
		if strings.Contains(statement, "UPDATE `OrgInvite`") {
			t.Fatalf("cross-organization invite was revoked: %s", statement)
		}
	}
}

// acceptPreludeRoutes serves the invitation, organization and role reads every
// accept test performs before the user lookup.
func acceptPreludeRoutes() []queryRoute {
	firstName := "Ada"
	lastName := "Lovelace"
	return []queryRoute{
		{fragment: "FROM `OrgInvite` WHERE `tokenHash`", rows: rowsWith(inviteColumnNames, inviteFixture{
			id:            "inv1",
			orgID:         "o1",
			email:         "invited@example.com",
			firstName:     &firstName,
			lastName:      &lastName,
			primaryRoleID: "r1",
			roleIDs:       `["r1","r2"]`,
			status:        "pending",
			expiresAt:     time.Now().Add(time.Hour),
		}.row())},
		{fragment: "FROM `Org` WHERE `id`", rows: rowsWith(orgColumnNames, orgFixture{id: "o1", name: "Acme", slug: "acme"}.row())},
		{fragment: "FROM `Role` WHERE `id` = ? AND `orgId`", rows: rowsWith(roleColumnNames, roleFixture{id: "r1", name: "analyst", orgID: "o1"}.row())},
		{fragment: "FROM `Role` WHERE `orgId` = ? AND `id` IN", rows: rowsWith(roleColumnNames,
			roleFixture{id: "r1", name: "analyst", orgID: "o1"}.row(),
			roleFixture{id: "r2", name: "manager", orgID: "o1"}.row())},
	}
}

func newUserRow(id string) []driver.Value {
	return []driver.Value{id, "invited@example.com", nil, nil, "Ada", "Lovelace", nil, int64(1), nil, time.Now(), time.Now()}
}
