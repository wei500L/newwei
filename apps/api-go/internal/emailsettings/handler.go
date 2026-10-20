package emailsettings

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
	"github.com/wei500L/newwei/apps/api-go/internal/smtpmail"
)

// Paths owned by this unit.
const (
	emailPath     = "/api/system-settings/email"
	authCodePath  = "/api/system-settings/email/auth-code"
	emailTestPath = "/api/system-settings/email/test"
)

// settingsPermission is the single permission the three routes require.
const settingsPermission = "settings.manage"

// verifyStatusTTL is the GET status cache window (EmailService.verifyCached(60_000)).
const verifyStatusTTL = 60 * time.Second

// Handler serves the three routes. The evaluation order mirrors NestJS:
// authentication (401) -> permission (403) -> DTO (400) -> platform admin (403)
// for the PUT.
type Handler struct {
	auth *platformgovernance.Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the service.
func NewHandler(auth *platformgovernance.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		settingshttp.WriteServiceError(w, r, settingshttp.ServiceUnavailable("Internal server error"))
		return
	}
	switch r.URL.Path {
	case emailPath:
		h.serveStatus(w, r)
	case authCodePath:
		h.serveAuthCode(w, r)
	case emailTestPath:
		h.serveTest(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveStatus(w http.ResponseWriter, r *http.Request) {
	if h.auth.Authorize(w, r, settingsPermission) == nil {
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	result, err := h.svc.status(r.Context())
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	settingshttp.WriteJSON(w, r, http.StatusOK, result)
}

func (h *Handler) serveAuthCode(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.Authorize(w, r, settingsPermission)
	if identity == nil {
		return
	}
	if r.Method != http.MethodPut {
		http.NotFound(w, r)
		return
	}
	body, ok := settingshttp.ReadBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseAuthCodeDTO(body)
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	if !h.auth.RequirePlatformAdmin(w, r, identity.UserID) {
		return
	}
	result, err := h.svc.updateSettings(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	settingshttp.WriteJSON(w, r, http.StatusOK, result)
}

func (h *Handler) serveTest(w http.ResponseWriter, r *http.Request) {
	if h.auth.Authorize(w, r, settingsPermission) == nil {
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, ok := settingshttp.ReadBodyOrFail(w, r)
	if !ok {
		return
	}
	to, subject, err := parseTestDTO(body)
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	result, err := h.svc.sendTest(r.Context(), to, subject, httpx.TraceIDFromContext(r.Context()))
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	settingshttp.WriteJSON(w, r, http.StatusCreated, result)
}

// status resolves the SMTP status, the process-local verify state and the
// effective auth-code settings. A failed verify is intentionally not an error:
// its message is reported in the verify block.
func (s *Service) status(ctx context.Context) (statusResponse, error) {
	_ = s.verify.verifyCached(ctx, verifyStatusTTL)
	authCode, err := s.settings(ctx)
	if err != nil {
		return statusResponse{}, err
	}
	return statusResponse{
		SMTP:     s.cfg.SMTP.status(),
		Verify:   s.verify.status(),
		AuthCode: authCode,
	}, nil
}

// sendTest performs the controller's recipient gate (D1: a disallowed recipient
// is a 400, not a 201 with ok:false), forces a fresh verify, and sends the
// multipart test message.
func (s *Service) sendTest(ctx context.Context, rawTo, rawSubject, traceID string) (testResponse, error) {
	smtpUser := s.cfg.SMTP.User
	recipient := strings.TrimSpace(rawTo)
	if recipient == "" {
		recipient = smtpUser
	}
	configuredDomain := domainOf(smtpUser)
	recipientDomain := domainOf(recipient)
	if configuredDomain == "" || recipientDomain == "" ||
		recipientDomain != configuredDomain ||
		!strings.EqualFold(recipient, smtpUser) {
		return testResponse{}, settingshttp.BadRequest(emailTestNotAllowedReason)
	}
	subject := strings.TrimSpace(rawSubject)
	if subject == "" {
		subject = "Test email"
	}
	if err := s.verify.verifyCached(ctx, 0); err != nil {
		return testResponse{}, err
	}

	nowISO := s.now().UTC().Format("2006-01-02T15:04:05.000Z")
	text := "This is a test email sent from Modular API at " + nowISO + "."
	html := "<p>This is a test email sent from <strong>Modular API</strong>.</p><p>Time: " + nowISO + "</p>"
	from := s.cfg.SMTP.From
	if from == "" {
		from = smtpUser
	}
	messageID := smtpmail.NewMessageID(from)
	result, err := s.sendMail(ctx, smtpmail.Message{
		From:      from,
		To:        recipient,
		Subject:   subject,
		Text:      text,
		HTML:      html,
		MessageID: messageID,
		TraceID:   traceID,
	})
	if err != nil {
		return testResponse{}, err
	}
	accepted := result.Accepted
	if accepted == nil {
		accepted = []string{}
	}
	rejected := result.Rejected
	if rejected == nil {
		rejected = []string{}
	}
	return testResponse{
		To:        recipient,
		MessageID: result.MessageID,
		Accepted:  accepted,
		Rejected:  rejected,
	}, nil
}

func domainOf(address string) string {
	at := strings.LastIndex(address, "@")
	if at < 0 || at == len(address)-1 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(address[at+1:]))
}
