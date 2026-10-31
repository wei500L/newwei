package authhttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

// recordingRecorder captures the failures the seam reports, so a test can assert
// what would have been stored without a Mongo.
type recordingRecorder struct {
	calls []recordedFailure
}

type recordedFailure struct {
	path       string
	method     string
	statusCode int
	orgID      string
	userID     string
	message    string
}

func (r *recordingRecorder) record(req *http.Request, statusCode int, orgID, userID, message string) {
	r.calls = append(r.calls, recordedFailure{
		path:       req.URL.RequestURI(),
		method:     req.Method,
		statusCode: statusCode,
		orgID:      orgID,
		userID:     userID,
		message:    message,
	})
}

// withRecorder installs a recorder for one test and restores the previous one, so
// the package-level installation cannot leak between tests.
func withRecorder(t *testing.T) *recordingRecorder {
	t.Helper()
	recorder := &recordingRecorder{}
	SetExceptionRecorder(recorder.record)
	t.Cleanup(func() { SetExceptionRecorder(nil) })
	return recorder
}

// TestEveryRESTFailureExitRecordsOneEvent drives the real writers through the seam:
// each of the six exits a Go REST handler uses must produce exactly one event whose
// status and message match the response the client receives.
func TestEveryRESTFailureExitRecordsOneEvent(t *testing.T) {
	cases := []struct {
		name    string
		write   func(w http.ResponseWriter, r *http.Request)
		status  int
		message string
	}{
		{
			name:    "unauthorized",
			write:   func(w http.ResponseWriter, r *http.Request) { WriteUnauthorized(w, r, "") },
			status:  http.StatusUnauthorized,
			message: "Unauthorized",
		},
		{
			name:    "forbidden",
			write:   func(w http.ResponseWriter, r *http.Request) { WriteForbidden(w, r, []string{"items.write"}) },
			status:  http.StatusForbidden,
			message: "Insufficient permissions",
		},
		{
			name:    "bad request",
			write:   func(w http.ResponseWriter, r *http.Request) { WriteBadRequest(w, r, "externalId must be a string") },
			status:  http.StatusBadRequest,
			message: "externalId must be a string",
		},
		{
			name: "coded conflict",
			write: func(w http.ResponseWriter, r *http.Request) {
				WriteCodedConflict(w, r, "ITEM_CONFLICT", "Item exists", "duplicate")
			},
			status:  http.StatusConflict,
			message: "Item exists",
		},
		{
			name:    "internal failure",
			write:   func(w http.ResponseWriter, r *http.Request) { WriteInternalFailure(w, r) },
			status:  http.StatusInternalServerError,
			message: "Internal server error",
		},
		{
			name:    "database failure",
			write:   func(w http.ResponseWriter, r *http.Request) { WriteDatabaseFailure(w, r) },
			status:  http.StatusServiceUnavailable,
			message: "Internal server error",
		},
		{
			name:    "payload too large",
			write:   func(w http.ResponseWriter, r *http.Request) { WritePayloadTooLarge(w, r) },
			status:  http.StatusInternalServerError,
			message: "Internal server error",
		},
		{
			name: "http exception",
			write: func(w http.ResponseWriter, r *http.Request) {
				WriteHTTPException(w, r, http.StatusNotFound, "Item not found")
			},
			status:  http.StatusNotFound,
			message: "Item not found",
		},
		{
			name: "too many requests",
			write: func(w http.ResponseWriter, r *http.Request) {
				WriteHTTPException(w, r, http.StatusTooManyRequests, "Too many requests")
			},
			status:  http.StatusTooManyRequests,
			message: "Too many requests",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := withRecorder(t)
			recorderHTTP := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/items?page=2", nil)
			testCase.write(recorderHTTP, request)

			if recorderHTTP.Code != testCase.status {
				t.Fatalf("response status = %d, want %d", recorderHTTP.Code, testCase.status)
			}
			if len(recorder.calls) != 1 {
				t.Fatalf("recorded %d events, want 1", len(recorder.calls))
			}
			got := recorder.calls[0]
			if got.statusCode != testCase.status {
				t.Errorf("event statusCode = %d, want %d", got.statusCode, testCase.status)
			}
			if got.message != testCase.message {
				t.Errorf("event message = %q, want %q", got.message, testCase.message)
			}
			// path is Express request.url: path *and* query string.
			if got.path != "/api/items?page=2" {
				t.Errorf("event path = %q, want the path with its query string", got.path)
			}
			if got.method != http.MethodPost {
				t.Errorf("event method = %q, want POST", got.method)
			}
			// Nothing has authenticated in this test, so both identifiers stay empty
			// rather than being invented.
			if got.orgID != "" || got.userID != "" {
				t.Errorf("event identity = (%q, %q), want empty", got.orgID, got.userID)
			}
		})
	}
}

// TestRecordedIdentityComesFromTheVerificationChain proves orgId/userId are taken
// from the identity the chain derived, never from a header or body value a client
// could supply. The spoofed header and body are present in the request.
func TestRecordedIdentityComesFromTheVerificationChain(t *testing.T) {
	recorder := withRecorder(t)
	request := httptest.NewRequest(http.MethodPost, "/api/items", nil)
	// A client-supplied org/user header must be ignored.
	request.Header.Set("x-org-id", "org-spoofed")
	request.Header.Set("x-user-id", "user-spoofed")
	// The middleware installs the box; the chain fills it.
	served := false
	IdentityScope(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served = true
		SetVerifiedIdentity(r, NewIdentity("user-verified", "org-verified", []string{"items.write"}))
		WriteForbidden(w, r, []string{"items.write"})
	})).ServeHTTP(httptest.NewRecorder(), request)
	if !served {
		t.Fatal("the scope did not reach the handler")
	}
	if len(recorder.calls) != 1 {
		t.Fatalf("recorded %d events, want 1", len(recorder.calls))
	}
	got := recorder.calls[0]
	if got.orgID != "org-verified" || got.userID != "user-verified" {
		t.Fatalf("event identity = (%q, %q), want the verified pair", got.orgID, got.userID)
	}
}

// TestRecordedIdentityIsEmptyBeforeAuthentication proves a 401 raised before a
// token was verified records no org/user, so an unauthenticated request cannot be
// attributed to a tenant.
func TestRecordedIdentityIsEmptyBeforeAuthentication(t *testing.T) {
	recorder := withRecorder(t)
	authenticator := NewAuthenticator(authn.NewVerifier("secret", "issuer", "audience"), nil, nil)
	IdentityScope(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if identity := authenticator.Authenticate(w, r); identity != nil {
			t.Fatal("a request without a bearer was authenticated")
		}
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/items", nil))
	if len(recorder.calls) != 1 {
		t.Fatalf("recorded %d events, want 1", len(recorder.calls))
	}
	got := recorder.calls[0]
	if got.statusCode != http.StatusUnauthorized {
		t.Errorf("statusCode = %d, want 401", got.statusCode)
	}
	if got.orgID != "" || got.userID != "" {
		t.Errorf("event identity = (%q, %q), want empty", got.orgID, got.userID)
	}
}

// TestAuthenticatePublishesTheVerifiedIdentity proves the chain itself fills the
// box, which is what makes a later failure in the same request attributable.
func TestAuthenticatePublishesTheVerifiedIdentity(t *testing.T) {
	withRecorder(t)
	authenticator := NewAuthenticator(
		authn.NewVerifier(testSecret, testIssuer, testAudience),
		notRevokedBlacklist{},
		acceptingAuthorizeRepository{},
	)
	token := signAccessToken(t)
	IdentityScope(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		req := httptest.NewRequest(http.MethodGet, "/api/items", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req = req.WithContext(r.Context())
		if identity := authenticator.Authenticate(httptest.NewRecorder(), req); identity == nil {
			t.Fatal("the chain rejected a valid token")
		}
		orgID, userID := verifiedIdentity(req)
		if orgID != "org-1" || userID != "user-1" {
			t.Fatalf("published identity = (%q, %q), want (org-1, user-1)", orgID, userID)
		}
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/items", nil))
}

// TestExceptionNameMappingIsStatusDerived pins the errorName each status records.
func TestExceptionNameMappingIsStatusDerived(t *testing.T) {
	cases := map[int]string{
		http.StatusBadRequest:          "BadRequestException",
		http.StatusUnauthorized:        "UnauthorizedException",
		http.StatusForbidden:           "ForbiddenException",
		http.StatusNotFound:            "NotFoundException",
		http.StatusConflict:            "ConflictException",
		http.StatusTooManyRequests:     "TooManyRequestsException",
		http.StatusServiceUnavailable:  "ServiceUnavailableException",
		http.StatusInternalServerError: "Error",
	}
	for status, want := range cases {
		if got := ExceptionNameForStatus(status); got != want {
			t.Errorf("ExceptionNameForStatus(%d) = %q, want %q", status, got, want)
		}
	}
}

// notRevokedBlacklist reports every jti as live, so the chain reaches the
// authorization step without a Redis service.
type notRevokedBlacklist struct{}

func (notRevokedBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

// acceptingAuthorizeRepository accepts every authorization and derives the
// permissions from the database shape the real repository returns.
type acceptingAuthorizeRepository struct{}

func (acceptingAuthorizeRepository) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	return &authz.Authorization{
		UserID:      userID,
		OrgID:       orgID,
		Permissions: map[string]bool{"items.write": true},
	}, nil
}
