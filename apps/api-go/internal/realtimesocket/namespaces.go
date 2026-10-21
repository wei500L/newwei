package realtimesocket

import (
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/socketio"
)

// Path is the dedicated Engine.IO path of the Go realtime transport. It is
// disjoint from the NestJS path "/socket.io", so the reverse proxy can route
// the five migrated namespaces to api-go while NestJS keeps everything else.
const Path = "/socket.io-realtime"

// Namespace constants mirror the five NestJS @WebSocketGateway namespace
// options replaced by this transport (baseline 1ba22e3b).
const (
	NamespaceNewsnow          = "/newsnow"
	NamespaceOps              = "/ops"
	NamespaceQuality          = "/quality"
	NamespaceQueue            = "/queue"
	NamespaceSituationMonitor = "/situation-monitor"
)

// Permission names are the authz permission strings checked at handshake time.
// They come from MySQL RolePermission rows, never from JWT claims.
const (
	permissionItemsRead      = "items.read"
	permissionCrawlRead      = "crawl.read"
	permissionCrawlWrite     = "crawl.write"
	permissionSettingsManage = "settings.manage"
	permissionQueueManage    = "queue.manage"
)

// Socket.IO event names are part of the browser contract. Every namespace uses
// its own prefix: "/situation-monitor" emits "situation:*" like the NestJS
// gateway (the prefix is not the namespace string).
const (
	eventNewsnowConnected        = "newsnow:connected"
	eventNewsnowError            = "newsnow:error"
	eventNewsnowSetActiveSources = "newsnow:set-active-sources"
	eventOpsConnected            = "ops:connected"
	eventOpsError                = "ops:error"
	eventQualityConnected        = "quality:connected"
	eventQualityError            = "quality:error"
	eventQueueConnected          = "queue:connected"
	eventQueueError              = "queue:error"
	eventSituationConnected      = "situation:connected"
	eventSituationError          = "situation:error"
)

// situationMonitorGlobalRoom is the room the NestJS situation gateway joins
// (situation-monitor-signals.constants.ts). Nothing currently emits to it, but
// the membership is part of the replicated contract.
const situationMonitorGlobalRoom = "global:situation-monitor-signals"

// Handshake rejection messages. The browser only ever sees these through
// socketio.NewErrorPayload: everything except the four rate-limit/connection-cap
// messages collapses to UNAUTHORIZED/Unauthorized.
const (
	messageOriginNotAllowed        = "Origin not allowed"
	messageInsufficientPermissions = "Insufficient permissions"
	messageMissingAuthToken        = "Missing auth token"
	messageInvalidToken            = "Invalid token"
	messageTokenRevoked            = "Token revoked"
)

// tokenOrderHeaderFirst mirrors the NestJS token precedence of /newsnow,
// /queue and /situation-monitor: Authorization header, CONNECT auth, query.
var tokenOrderHeaderFirst = []socketio.TokenSource{
	socketio.TokenFromHeader,
	socketio.TokenFromAuth,
	socketio.TokenFromQuery,
}

// tokenOrderAuthFirst mirrors the NestJS token precedence of /ops and
// /quality: CONNECT auth, query, Authorization header. The inconsistency is in
// the baseline gateways and must be preserved byte for byte.
var tokenOrderAuthFirst = []socketio.TokenSource{
	socketio.TokenFromAuth,
	socketio.TokenFromQuery,
	socketio.TokenFromHeader,
}

// namespaceSpec is the per-namespace handshake contract extracted from the five
// NestJS gateways: token precedence, permission gate, connection-rate buckets,
// client-event support and extra rooms.
type namespaceSpec struct {
	namespace      string
	connectedEvent string
	errorEvent     string
	tokenSources   []socketio.TokenSource
	permissions    []string
	userRateLimit  bool
	clientEvents   bool
	extraRooms     []string
}

// allows reports whether the DB-derived permission set satisfies the
// namespace gate. A namespace with several entries accepts any of them
// (the /ops gateway requires crawl.read OR crawl.write).
func (s *namespaceSpec) allows(authorization *authz.Authorization) bool {
	if authorization == nil {
		return false
	}
	for _, permission := range s.permissions {
		if authorization.HasPermission(permission) {
			return true
		}
	}
	return false
}

// namespaceSpecs is the complete routing table of the transport. The order in
// this map is irrelevant; browser frames name the namespace explicitly.
var namespaceSpecs = map[string]*namespaceSpec{
	NamespaceNewsnow: {
		namespace:      NamespaceNewsnow,
		connectedEvent: eventNewsnowConnected,
		errorEvent:     eventNewsnowError,
		tokenSources:   tokenOrderHeaderFirst,
		permissions:    []string{permissionItemsRead},
		userRateLimit:  true,
		clientEvents:   true,
	},
	NamespaceOps: {
		namespace:      NamespaceOps,
		connectedEvent: eventOpsConnected,
		errorEvent:     eventOpsError,
		tokenSources:   tokenOrderAuthFirst,
		permissions:    []string{permissionCrawlRead, permissionCrawlWrite},
	},
	NamespaceQuality: {
		namespace:      NamespaceQuality,
		connectedEvent: eventQualityConnected,
		errorEvent:     eventQualityError,
		tokenSources:   tokenOrderAuthFirst,
		permissions:    []string{permissionSettingsManage},
		// The NestJS quality gateway does not attach token revalidation. This
		// batch enables it for all five namespaces on purpose: logout must cut
		// every live realtime socket, and leaving one namespace exempt would be
		// a security regression once Go owns the whole path.
	},
	NamespaceQueue: {
		namespace:      NamespaceQueue,
		connectedEvent: eventQueueConnected,
		errorEvent:     eventQueueError,
		tokenSources:   tokenOrderHeaderFirst,
		permissions:    []string{permissionQueueManage},
	},
	NamespaceSituationMonitor: {
		namespace:      NamespaceSituationMonitor,
		connectedEvent: eventSituationConnected,
		errorEvent:     eventSituationError,
		tokenSources:   tokenOrderHeaderFirst,
		permissions:    []string{permissionItemsRead},
		userRateLimit:  true,
		extraRooms:     []string{situationMonitorGlobalRoom},
	},
}

// orgRoom, userRoom and ipRoom build the socket.io room names used by
// UserSessionManager (user-session-manager.service.ts:71-81).
func orgRoom(orgID string) string   { return "org:" + orgID }
func userRoom(userID string) string { return "user:" + userID }
func ipRoom(ip string) string       { return "ip:" + ip }

// shouldRecordFailedAuth mirrors shouldRecordFailedSocketAuth: the four
// rate-limit/connection-cap messages do not increase the per-IP failed-auth
// backoff; origin, token, revocation, membership and permission rejections do.
func shouldRecordFailedAuth(message string) bool {
	switch message {
	case socketio.MessageRateLimitExceeded,
		socketio.MessageTooManyFailedAttempts,
		socketio.MessageTooManyConnections,
		socketio.MessageTooManyConnectionAttempt:
		return false
	default:
		return true
	}
}
