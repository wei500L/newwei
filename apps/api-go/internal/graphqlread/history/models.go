package history

import "time"

// AnalysisResultModel is the GraphQL AnalysisResultModel object.
type AnalysisResultModel struct {
	CreatedAt time.Time `graphql:"createdAt"`
	Error     *string   `graphql:"error"`
	ID        string    `graphql:"id"`
	Input     any       `graphql:"input"`
	Output    any       `graphql:"output"`
	Status    string    `graphql:"status"`
	Summary   *string   `graphql:"summary"`
	Type      string    `graphql:"type"`
}

// AssistantRunModel is the GraphQL AssistantRunModel object.
type AssistantRunModel struct {
	ConversationID *string   `graphql:"conversationId"`
	CreatedAt      time.Time `graphql:"createdAt"`
	Error          *string   `graphql:"error"`
	ID             string    `graphql:"id"`
	Input          any       `graphql:"input"`
	Output         any       `graphql:"output"`
	Status         string    `graphql:"status"`
	Summary        *string   `graphql:"summary"`
	Type           string    `graphql:"type"`
}

// EconomicSeriesSuggestion is the GraphQL EconomicSeriesSuggestion object.
type EconomicSeriesSuggestion struct {
	Description *string `graphql:"description"`
	DisplayName string  `graphql:"displayName"`
	DocURL      *string `graphql:"docUrl"`
	Slug        string  `graphql:"slug"`
}

// AssistantRuntimeCapabilitiesModel is the GraphQL AssistantRuntimeCapabilitiesModel object.
type AssistantRuntimeCapabilitiesModel struct {
	APISurface         *string `graphql:"apiSurface"`
	AssistantModel     *string `graphql:"assistantModel"`
	WebSearchSupported bool    `graphql:"webSearchSupported"`
}

// NotificationModel is the GraphQL NotificationModel object.
type NotificationModel struct {
	Body      *string    `graphql:"body"`
	CreatedAt time.Time  `graphql:"createdAt"`
	Data      any        `graphql:"data"`
	ID        string     `graphql:"id"`
	ReadAt    *time.Time `graphql:"readAt"`
	Title     string     `graphql:"title"`
	Type      string     `graphql:"type"`
}
