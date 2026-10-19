// Package graphqlsubscriptions serves the four realtime GraphQL subscriptions
// on an exact /graphql graphql-transport-ws connection.
//
// It is independent of API_GO_GRAPHQL_READ_MODE and of every write switch. It
// owns the Subscription namespace, the Redis pub/sub reader for the three
// existing gqlsub:* channels, and the per-process read-only BullMQ observer
// for queueEvents. Query, Mutation and unsupported subscription operations on
// the same connection are forwarded as one whole operation to NestJS.
package graphqlsubscriptions

import (
	"encoding/json"
	"time"
)

// AnalysisResultModel is the AnalysisResultModel object returned by
// analysisEvents. input and output stay null for live events: the envelope
// never carries them and this task must not read history to fill them in.
type AnalysisResultModel struct {
	CreatedAt time.Time        `graphql:"createdAt"`
	Error     *string          `graphql:"error"`
	ID        string           `graphql:"id"`
	Input     *json.RawMessage `graphql:"input"`
	Output    *json.RawMessage `graphql:"output"`
	Status    string           `graphql:"status"`
	Summary   *string          `graphql:"summary"`
	Type      string           `graphql:"type"`
}

// AssistantRunModel is the AssistantRunModel object returned by
// assistantEvents. conversationId remains null because the envelope does not
// carry it; history is not queried to enrich a live event.
type AssistantRunModel struct {
	ConversationID *string          `graphql:"conversationId"`
	CreatedAt      time.Time        `graphql:"createdAt"`
	Error          *string          `graphql:"error"`
	ID             string           `graphql:"id"`
	Input          *json.RawMessage `graphql:"input"`
	Output         *json.RawMessage `graphql:"output"`
	Status         string           `graphql:"status"`
	Summary        *string          `graphql:"summary"`
	Type           string           `graphql:"type"`
}
