// Package assistantwrite registers the four assistant write mutations into the
// Go GraphQL executor. It owns no object type: AssistantRunModel is registered
// exactly once by graphqlread/history (or by the caller before Register).
package assistantwrite

import (
	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the four mutations with the assistant.run permission.
func Register(reg *contract.Registry, service *assistantruns.Service) {
	if reg == nil {
		panic("graphqlread: assistantwrite.Register requires a registry")
	}
	if service == nil {
		panic("graphqlread: assistantwrite.Register requires a service")
	}
	resolvers := &resolvers{service: service}
	reg.RegisterMutation(contract.Root{
		Name:       "requestAssistantQuery",
		Permission: "assistant.run",
		Resolve:    contract.Bind(resolvers.requestAssistantQuery),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "requestAssistantReport",
		Permission: "assistant.run",
		Resolve:    contract.Bind(resolvers.requestAssistantReport),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "requestAssistantForecast",
		Permission: "assistant.run",
		Resolve:    contract.Bind(resolvers.requestAssistantForecast),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "deleteAssistantRun",
		Permission: "assistant.run",
		Resolve:    contract.Bind(resolvers.deleteAssistantRun),
	})
}

// RegisteredMutations lists the mutation names Register adds.
var RegisteredMutations = []string{
	"requestAssistantQuery",
	"requestAssistantReport",
	"requestAssistantForecast",
	"deleteAssistantRun",
}
