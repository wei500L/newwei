package identityonboarding

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Route paths owned by this unit. Every one of them is registered as an exact
// path (or a one-segment path with a fixed suffix) in legacyproxy; the handler
// repeats the method and shape checks so a mis-registration can never serve a
// different method.
const (
	pathAdminInvites                    = "/api/auth/admin/invites"
	pathAdminInvitesPrefix              = "/api/auth/admin/invites/"
	pathRegistrationApplications        = "/api/auth/admin/registration-applications"
	pathRegistrationApplicationsPrefix  = "/api/auth/admin/registration-applications/"
	pathRegisterApplications            = "/api/auth/register/applications"
	pathRegisterJoinApplications        = "/api/auth/register/join-applications"
	pathInvitationsPrefix               = "/api/auth/invitations/"
	inviteResendSuffix                  = "/resend"
	inviteRevokeSuffix                  = "/revoke"
	applicationApproveJoinSuffix        = "/approve-join"
	applicationRejectJoinSuffix         = "/reject-join"
	applicationApproveOrgSuffix         = "/approve-org"
	applicationRejectOrgSuffix          = "/reject-org"
	invitationAcceptAuthenticatedSuffix = "/accept-authenticated"
	invitationAcceptSuffix              = "/accept"
	usersWritePermission                = "users.write"
)

// Handler serves the fourteen routes. Authentication, body decoding and response
// writing live here; persistence and validation live in Service.
//
// The evaluation order matches NestJS:
//
//	authentication (401) -> permission (403) -> DTO validation (400)
//	-> human-identity or platform-role checks -> business writes.
type Handler struct {
	auth *Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the service.
func NewHandler(auth *Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case pathAdminInvites:
		h.serveInvites(w, r)
	case pathRegistrationApplications:
		h.serveApplicationList(w, r)
	case pathRegisterApplications:
		h.serveSubmitNewOrg(w, r)
	case pathRegisterJoinApplications:
		h.serveSubmitJoinOrg(w, r)
	default:
		h.serveDynamic(w, r)
	}
}

// serveDynamic dispatches the paths that carry one dynamic segment.
func (h *Handler) serveDynamic(w http.ResponseWriter, r *http.Request) {
	if rest, ok := strings.CutPrefix(r.URL.Path, pathAdminInvitesPrefix); ok {
		if inviteID, ok := singleSegment(rest, inviteResendSuffix); ok {
			h.serveResendInvite(w, r, inviteID)
			return
		}
		if inviteID, ok := singleSegment(rest, inviteRevokeSuffix); ok {
			h.serveRevokeInvite(w, r, inviteID)
			return
		}
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, pathRegistrationApplicationsPrefix); ok {
		if applicationID, ok := singleSegment(rest, applicationApproveJoinSuffix); ok {
			h.serveApproveJoin(w, r, applicationID)
			return
		}
		if applicationID, ok := singleSegment(rest, applicationRejectJoinSuffix); ok {
			h.serveRejectJoin(w, r, applicationID)
			return
		}
		if applicationID, ok := singleSegment(rest, applicationApproveOrgSuffix); ok {
			h.serveApproveOrg(w, r, applicationID)
			return
		}
		if applicationID, ok := singleSegment(rest, applicationRejectOrgSuffix); ok {
			h.serveRejectOrg(w, r, applicationID)
			return
		}
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, pathInvitationsPrefix); ok {
		if token, ok := singleSegment(rest, invitationAcceptAuthenticatedSuffix); ok {
			h.serveAcceptAuthenticated(w, r, token)
			return
		}
		if token, ok := singleSegment(rest, invitationAcceptSuffix); ok {
			h.serveAccept(w, r, token)
			return
		}
		if token, ok := singleSegment(rest, ""); ok {
			h.serveInvitationPreview(w, r, token)
			return
		}
	}
	http.NotFound(w, r)
}

// singleSegment strips a fixed suffix and requires exactly one non-empty segment
// with no further slash.
func singleSegment(rest, suffix string) (string, bool) {
	if suffix != "" {
		if !strings.HasSuffix(rest, suffix) {
			return "", false
		}
		rest = strings.TrimSuffix(rest, suffix)
	}
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// serveInvites handles GET and POST /api/auth/admin/invites.
func (h *Handler) serveInvites(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		identity := h.auth.authorize(w, r, usersWritePermission)
		if identity == nil {
			return
		}
		invites, err := h.svc.ListInvites(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, invites)
	case http.MethodPost:
		identity := h.auth.authorize(w, r, usersWritePermission)
		if identity == nil {
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		request, err := parseCreateInviteRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		invite, err := h.svc.CreateInvite(r.Context(), identity.OrgID, identity.UserID, createInviteInput{
			Email:         request.Email,
			FirstName:     request.FirstName,
			LastName:      request.LastName,
			PrimaryRoleID: request.PrimaryRoleID,
			RoleIDs:       request.RoleIDs,
		})
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusCreated, invite)
	default:
		http.NotFound(w, r)
	}
}

// serveResendInvite handles POST /api/auth/admin/invites/:id/resend.
func (h *Handler) serveResendInvite(w http.ResponseWriter, r *http.Request, inviteID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, usersWritePermission)
	if identity == nil {
		return
	}
	invite, err := h.svc.ResendInvite(r.Context(), identity.OrgID, identity.UserID, inviteID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, invite)
}

// serveRevokeInvite handles POST /api/auth/admin/invites/:id/revoke.
func (h *Handler) serveRevokeInvite(w http.ResponseWriter, r *http.Request, inviteID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, usersWritePermission)
	if identity == nil {
		return
	}
	invite, err := h.svc.RevokeInvite(r.Context(), identity.OrgID, identity.UserID, inviteID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, invite)
}

// serveApplicationList handles GET /api/auth/admin/registration-applications.
// The route only requires authentication; the service decides visibility and
// answers 403 when the caller has neither users.write nor platform_admin.
func (h *Handler) serveApplicationList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	list, err := h.svc.ListApplications(r.Context(), identity.UserID, identity.OrgID,
		identity.HasPermission(usersWritePermission))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, list)
}

// serveApproveJoin handles POST .../:id/approve-join.
func (h *Handler) serveApproveJoin(w http.ResponseWriter, r *http.Request, applicationID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, usersWritePermission)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseApproveJoinRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	application, err := h.svc.ApproveJoin(r.Context(), identity.UserID, identity.OrgID, applicationID,
		request.PrimaryRoleID, request.RoleIDs)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, application)
}

// serveRejectJoin handles POST .../:id/reject-join.
func (h *Handler) serveRejectJoin(w http.ResponseWriter, r *http.Request, applicationID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, usersWritePermission)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseRejectApplicationRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	application, err := h.svc.RejectJoin(r.Context(), identity.UserID, identity.OrgID, applicationID, request.Reason)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, application)
}

// serveApproveOrg handles POST .../:id/approve-org. The route only requires
// authentication; the service checks the global platform role.
func (h *Handler) serveApproveOrg(w http.ResponseWriter, r *http.Request, applicationID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	application, err := h.svc.ApproveNewOrg(r.Context(), identity.UserID, applicationID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, application)
}

// serveRejectOrg handles POST .../:id/reject-org.
func (h *Handler) serveRejectOrg(w http.ResponseWriter, r *http.Request, applicationID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseRejectApplicationRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	application, err := h.svc.RejectNewOrg(r.Context(), identity.UserID, applicationID, request.Reason)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, application)
}

// serveSubmitNewOrg handles the public POST /api/auth/register/applications.
// NestJS marks this handler @HttpCode(200), so the success status is 200.
func (h *Handler) serveSubmitNewOrg(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseSubmitNewOrgRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	application, err := h.svc.SubmitNewOrgApplication(r.Context(), request)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, application)
}

// serveSubmitJoinOrg handles the public POST /api/auth/register/join-applications.
// NestJS marks this handler @HttpCode(200), so the success status is 200.
func (h *Handler) serveSubmitJoinOrg(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseSubmitJoinOrgRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	application, err := h.svc.SubmitJoinOrgApplication(r.Context(), request)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, application)
}

// serveInvitationPreview handles the public GET /api/auth/invitations/:token.
func (h *Handler) serveInvitationPreview(w http.ResponseWriter, r *http.Request, token string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	preview, err := h.svc.GetInviteByToken(r.Context(), token)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, preview)
}

// serveAccept handles the public POST /api/auth/invitations/:token/accept.
func (h *Handler) serveAccept(w http.ResponseWriter, r *http.Request, token string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseAcceptInviteRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	membership, err := h.svc.AcceptInvite(r.Context(), acceptInviteParams{
		Token:     token,
		Password:  request.Password,
		FirstName: request.FirstName,
		LastName:  request.LastName,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, membership)
}

// serveAcceptAuthenticated handles POST .../:token/accept-authenticated.
func (h *Handler) serveAcceptAuthenticated(w http.ResponseWriter, r *http.Request, token string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	membership, err := h.svc.AcceptInvite(r.Context(), acceptInviteParams{
		Token:         token,
		CurrentUserID: identity.UserID,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, membership)
}
