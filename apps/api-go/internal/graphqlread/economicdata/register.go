// Package economicdata registers the three economic-data mutations that own
// configuration, manual fetch and preset refresh. It is deliberately separate
// from graphqlread/economic: the six read roots are gated by the read switch and
// must not be widened by the request switch.
package economicdata

import (
	"encoding/json"
	"net/http"

	econdata "github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
)

// RegisteredMutations lists the roots this Register adds.
var RegisteredMutations = []string{
	"updateEconomicDataFetchConfig",
	"triggerDataFetch",
	"triggerEconomicDataRefreshPreset",
}

// Register adds the three roots and the two object types they return. The read
// package may already have registered the same types; Register checks first so
// both switches can be go together.
func Register(reg *contract.Registry, service *econdata.Service) {
	if reg == nil || service == nil {
		panic("graphqlread/economicdata: Register requires a registry and service")
	}
	if !reg.HasType("EconomicDataItemModel") {
		reg.RegisterType("EconomicDataItemModel", economic.EconomicDataItemModel{})
	}
	if !reg.HasType("EconomicDataFetchConfigModel") {
		reg.RegisterType("EconomicDataFetchConfigModel", economic.EconomicDataFetchConfigModel{})
	}
	reg.RegisterMutation(contract.Root{Name: "updateEconomicDataFetchConfig", Permission: "economicdata.manage", Resolve: contract.Bind(func(call contract.Context) (economic.EconomicDataFetchConfigModel, error) {
		return updateFetchConfig(call, service)
	})})
	reg.RegisterMutation(contract.Root{Name: "triggerDataFetch", Permission: "economicdata.manage", Resolve: contract.Bind(func(call contract.Context) (bool, error) {
		return triggerDataFetch(call, service)
	})})
	reg.RegisterMutation(contract.Root{Name: "triggerEconomicDataRefreshPreset", Permission: "economicdata.manage", Resolve: contract.Bind(func(call contract.Context) (bool, error) {
		return triggerPreset(call, service)
	})})
}

func updateFetchConfig(call contract.Context, service *econdata.Service) (economic.EconomicDataFetchConfigModel, error) {
	slug, ok := contract.StringArg(call.Args, "slug")
	if !ok {
		return economic.EconomicDataFetchConfigModel{}, badRequest("slug is required")
	}
	update := econdata.FetchConfigUpdate{}
	if raw, state := contract.Lookup(call.Args, "frequency"); state == contract.ArgValue {
		value, ok := raw.(string)
		if !ok || !validFrequency(value) {
			return economic.EconomicDataFetchConfigModel{}, badRequest("frequency must be an EconomicDataFrequency")
		}
		frequency := econdata.Frequency(value)
		update.Frequency = &frequency
	}
	if raw, state := contract.Lookup(call.Args, "repeatCron"); state != contract.ArgMissing {
		update.RepeatCronSet = true
		if state == contract.ArgNull {
			update.RepeatCron = nil
		} else {
			value, ok := raw.(string)
			if !ok {
				return economic.EconomicDataFetchConfigModel{}, badRequest("repeatCron must be a string")
			}
			update.RepeatCron = &value
		}
	}
	if raw, state := contract.Lookup(call.Args, "isEnabled"); state == contract.ArgValue {
		value, ok := raw.(bool)
		if !ok {
			return economic.EconomicDataFetchConfigModel{}, badRequest("isEnabled must be a boolean")
		}
		update.IsEnabled = &value
	}
	config, err := service.UpdateFetchConfig(call.Ctx, slug, update)
	if err != nil {
		return economic.EconomicDataFetchConfigModel{}, mutationFailure(err)
	}
	return mapFetchConfig(config), nil
}

func triggerDataFetch(call contract.Context, service *econdata.Service) (bool, error) {
	raw, state := contract.Lookup(call.Args, "input")
	if state != contract.ArgValue {
		return false, badRequest("input is required")
	}
	input, ok := raw.(map[string]any)
	if !ok {
		return false, badRequest("input is required")
	}
	slugs, err := stringList(input, "slugs")
	if err != nil {
		return false, err
	}
	if err := service.TriggerDataFetch(call.Ctx, slugs, ""); err != nil {
		return false, mutationFailure(err)
	}
	return true, nil
}

func triggerPreset(call contract.Context, service *econdata.Service) (bool, error) {
	preset, ok := contract.StringArg(call.Args, "preset")
	if !ok || preset == "" {
		return false, badRequest("preset is required")
	}
	if _, ok := econdata.PresetCategoryKeys[preset]; !ok {
		return false, badRequest("Unsupported economic refresh preset: " + preset)
	}
	orgID := call.Identity.OrgID
	if err := service.EnforcePresetLimit(call.Ctx, orgID, preset); err != nil {
		return false, mutationFailure(err)
	}
	ipAddress := econdata.RequestIPFromContext(call.Ctx)
	trigger := econdata.TriggerContext{ActorID: call.Identity.UserID, OrgID: orgID}
	if ipAddress != "" {
		trigger.IPAddress = &ipAddress
	}
	if err := service.TriggerDataFetchForPreset(call.Ctx, preset, trigger); err != nil {
		return false, mutationFailure(err)
	}
	return true, nil
}

func stringList(input map[string]any, name string) ([]string, error) {
	raw, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil, badRequest(name + " is required")
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, badRequest(name + " must be a list of strings")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, badRequest(name + " must be a list of strings")
		}
		out = append(out, text)
	}
	return out, nil
}

func validFrequency(value string) bool {
	switch econdata.Frequency(value) {
	case econdata.FrequencyRealtime, econdata.FrequencyHourly, econdata.FrequencyDaily,
		econdata.FrequencyWeekly, econdata.FrequencyMonthly:
		return true
	default:
		return false
	}
}

func mapFetchConfig(config econdata.FetchConfig) economic.EconomicDataFetchConfigModel {
	return economic.EconomicDataFetchConfigModel{
		ID:         config.ID,
		Frequency:  string(config.Frequency),
		RepeatCron: config.RepeatCron,
		IsEnabled:  config.IsEnabled,
		LastRunAt:  config.LastRunAt,
		LastStatus: runStatusString(config.LastStatus),
		LastError:  config.LastError,
		Item: economic.EconomicDataItemModel{
			Slug:        config.Item.Slug,
			DisplayName: config.Item.DisplayName,
			GroupLabel:  config.Item.GroupLabel,
			DefaultUnit: config.Item.DefaultUnit,
			Metadata:    metadataValue(config.Item.Metadata),
		},
	}
}

func runStatusString(status *econdata.RunStatus) *string {
	if status == nil {
		return nil
	}
	value := string(*status)
	return &value
}

func metadataValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	if _, ok := value.(map[string]any); !ok {
		return nil
	}
	return value
}

func badRequest(message string) *contract.Failure {
	return &contract.Failure{Status: http.StatusBadRequest, Message: message}
}

func mutationFailure(err error) *contract.Failure {
	switch typed := err.(type) {
	case *econdata.ItemNotFoundError:
		return &contract.Failure{Status: http.StatusInternalServerError, Message: typed.Error(), ExposeMessage: true}
	case *econdata.FetchConfigMissingError:
		return &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	case *econdata.PresetError:
		return &contract.Failure{Status: http.StatusBadRequest, Message: typed.Message}
	case *econdata.RateLimitError:
		return &contract.Failure{Status: http.StatusTooManyRequests, Message: typed.Message}
	default:
		return &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
}
