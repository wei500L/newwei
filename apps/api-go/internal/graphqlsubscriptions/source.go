package graphqlsubscriptions

import (
	"context"
	"fmt"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// FeedEvent is one strongly typed subscription payload addressed to exactly
// one organization. OrgID is set for Redis-fed roots; the queue hub already
// indexes by organization, so its events leave it empty.
type FeedEvent struct {
	OrgID string
	Value any
	Error *contract.SubscriptionEventError
}

// FeedSource opens one organization-scoped event stream. Implementations must
// stop reading and release their registration when ctx is cancelled.
type FeedSource interface {
	Subscribe(ctx context.Context, root, orgID string) (<-chan FeedEvent, error)
}

var subscriptionRoots = []struct {
	name       string
	permission string
}{
	{name: "alertEvents", permission: "alerts.read"},
	{name: "analysisEvents", permission: "analysis.read"},
	{name: "assistantEvents", permission: "assistant.read"},
	{name: "queueEvents", permission: "queue.manage"},
}

func validSubscriptionRoot(root string) bool {
	for _, spec := range subscriptionRoots {
		if spec.name == root {
			return true
		}
	}
	return false
}

// compositeSource routes the three Redis channels to the shared bus and
// queueEvents to the per-process BullMQ observer.
type compositeSource struct {
	bus   *Bus
	queue *QueueObserver
}

func (s *compositeSource) Subscribe(ctx context.Context, root, orgID string) (<-chan FeedEvent, error) {
	switch root {
	case "alertEvents", "analysisEvents", "assistantEvents":
		if s.bus == nil {
			return nil, fmt.Errorf("graphqlsubscriptions: Redis subscription bus is not available")
		}
		return s.bus.Subscribe(ctx, root, orgID)
	case "queueEvents":
		if s.queue == nil {
			return nil, fmt.Errorf("graphqlsubscriptions: queue observer is not available")
		}
		return s.queue.Subscribe(ctx, orgID), nil
	default:
		return nil, fmt.Errorf("graphqlsubscriptions: unknown subscription root %q", root)
	}
}
