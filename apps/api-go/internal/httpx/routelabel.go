package httpx

import (
	"context"
	"sync/atomic"
)

// routeLabelKey is the context key carrying the *RouteLabelSink that the
// outermost request middleware installs.
type routeLabelKey struct{}

// UnmatchedRouteLabel is the http_request_duration_seconds route label for a
// request no route served. The literal matches apps/api/src/main.ts:83-87, where
// NestJS substitutes "unmatched" for a req.route-less request instead of using
// the URL, so scan traffic cannot create unbounded Prometheus series.
const UnmatchedRouteLabel = "unmatched"

// RouteLabelSink receives the bounded route label the gateway resolved for the
// current request.
//
// The gateway learns the label while it matches its route table, which happens
// after the outer middleware has wrapped the writer. A context value cannot
// travel back up, so the outer middleware installs a sink and the gateway writes
// into it; the sink is a pointer, so the middleware observes the label once
// ServeHTTP returns.
//
// An unset sink reports UnmatchedRouteLabel, which is also what the gateway
// records for a request no rule claimed.
type RouteLabelSink struct{ label atomic.Value }

// WithRouteLabelSink installs a sink and returns it for reading after the
// handler returns.
func WithRouteLabelSink(ctx context.Context) (context.Context, *RouteLabelSink) {
	sink := &RouteLabelSink{}
	return context.WithValue(ctx, routeLabelKey{}, sink), sink
}

// SetRouteLabel records the resolved label on the request's sink. It is a no-op
// when the request was not wrapped by the metrics middleware, so a handler test
// calling the gateway directly needs no sink.
func SetRouteLabel(ctx context.Context, label string) {
	if label == "" {
		return
	}
	if sink, ok := ctx.Value(routeLabelKey{}).(*RouteLabelSink); ok && sink != nil {
		sink.label.Store(label)
	}
}

// Label returns the recorded label, or UnmatchedRouteLabel when nothing recorded
// one.
func (s *RouteLabelSink) Label() string {
	if s == nil {
		return UnmatchedRouteLabel
	}
	label, ok := s.label.Load().(string)
	if !ok || label == "" {
		return UnmatchedRouteLabel
	}
	return label
}
