// Package outbound owns the process-wide outbound HTTP transport and the small
// factory api-go uses to build *http.Client values on top of it.
//
// Every caller that does not need a custom transport shares one *http.Transport,
// so keep-alive connections to an upstream are reused across packages instead of
// each client opening and draining its own idle pool. Callers with a documented
// exception (custom TLS, outbound proxy, a pinned SSRF dialer, an IPv4-forcing
// dialer or a private pool that calls CloseIdleConnections) pass WithTransport.
package outbound

import (
	"net/http"
	"time"
)

// sharedTransport is the process-wide transport. It is cloned from
// http.DefaultTransport so Proxy (ProxyFromEnvironment), ForceAttemptHTTP2, TLS
// negotiation and every other standard-library default stay identical; only the
// idle pool sizing is raised so a process that fans out to one upstream keeps
// more connections warm.
var sharedTransport = newSharedTransport()

func newSharedTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 32
	transport.IdleConnTimeout = 90 * time.Second
	return transport
}

// options holds the per-call overrides applied by NewClient.
type options struct {
	transport     http.RoundTripper
	checkRedirect func(*http.Request, []*http.Request) error
}

// Option customizes a client built by NewClient.
type Option func(*options)

// WithTransport makes the client use rt instead of the shared transport. Use it
// only for the documented exceptions where sharing the default transport would
// break behaviour: a custom TLS config, an outbound proxy, a pinned dialer (SSRF
// protection), an address-family dialer or a private idle pool whose
// CloseIdleConnections must not touch other callers. A nil rt is ignored.
func WithTransport(rt http.RoundTripper) Option {
	return func(o *options) {
		if rt != nil {
			o.transport = rt
		}
	}
}

// NoRedirect disables automatic redirect following. The client then returns the
// upstream 3xx response (CheckRedirect returns http.ErrUseLastResponse) so the
// caller can validate every hop itself.
func NoRedirect() Option {
	return func(o *options) {
		o.checkRedirect = func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
}

// WithCheckRedirect installs a custom redirect policy, for callers that follow
// redirects but cap the hop count. A nil fn is ignored.
func WithCheckRedirect(fn func(*http.Request, []*http.Request) error) Option {
	return func(o *options) {
		if fn != nil {
			o.checkRedirect = fn
		}
	}
}

// NewClient returns an *http.Client with the given timeout over the shared
// transport unless an Option overrides it. A zero timeout keeps the client
// without a global timeout, leaving the request context as the deadline, which
// is what the migrated callers relied on.
func NewClient(timeout time.Duration, opts ...Option) *http.Client {
	o := options{transport: sharedTransport}
	for _, opt := range opts {
		opt(&o)
	}
	return &http.Client{
		Timeout:       timeout,
		Transport:     o.transport,
		CheckRedirect: o.checkRedirect,
	}
}
