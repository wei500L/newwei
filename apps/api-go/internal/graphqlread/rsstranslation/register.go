package rsstranslation

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	domain "github.com/wei500L/newwei/apps/api-go/internal/rsstranslation"
)

// itemsReadPermission is the NestJS root permission of translateRssItems. It is
// items.read, not items.write.
const itemsReadPermission = "items.read"

// resolver owns the migrated RSS translation mutation.
type resolver struct {
	svc *domain.Service
}

// Register adds the translateRssItems mutation and the two payload models it
// projects. The root permission matches the NestJS @HasPermission("items.read").
func Register(reg *contract.Registry, svc *domain.Service) {
	if reg == nil {
		panic("graphqlread: rsstranslation.Register requires a registry")
	}
	reg.RegisterType("TranslateRssItemsPayloadModel", TranslateRssItemsPayloadModel{})
	reg.RegisterType("RssItemTranslationModel", RssItemTranslationModel{})
	instance := &resolver{svc: svc}
	reg.RegisterMutation(contract.Root{
		Name:       "translateRssItems",
		Permission: itemsReadPermission,
		Resolve:    contract.Bind(instance.translateRssItems),
	})
}

// translateRssItems derives the tenant binding from the authenticated identity
// and never reads orgId from the input.
func (r *resolver) translateRssItems(ctx contract.Context) (TranslateRssItemsPayloadModel, error) {
	orgID, err := requireOrgID(ctx)
	if err != nil {
		return TranslateRssItemsPayloadModel{}, err
	}
	input, err := decodeTranslateInput(ctx.Args)
	if err != nil {
		return TranslateRssItemsPayloadModel{}, mapFailure(err)
	}
	result, err := r.svc.Translate(ctx.Ctx, orgID, input)
	if err != nil {
		return TranslateRssItemsPayloadModel{}, mapFailure(err)
	}
	return toModel(result), nil
}

// requireOrgID derives the tenant binding from the authenticated identity,
// matching the other migrated GraphQL roots.
func requireOrgID(ctx contract.Context) (string, error) {
	orgID := strings.TrimSpace(ctx.Identity.OrgID)
	if orgID == "" {
		return "", &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized}
	}
	return orgID, nil
}

// mapFailure maps the domain failures onto the GraphQL failure contract. A
// RequestError keeps its status and message; an input failure is a 400; any
// other error is a masked 500 with a server-side log line.
func mapFailure(err error) error {
	if err == nil {
		return nil
	}
	var requestErr *domain.RequestError
	if errors.As(err, &requestErr) {
		return &contract.Failure{Message: requestErr.Message, Status: requestErr.Status}
	}
	var inputErr *inputFailure
	if errors.As(err, &inputErr) {
		return &contract.Failure{Message: inputErr.message, Status: http.StatusBadRequest}
	}
	log.Printf("api-go: rsstranslation graphql failure: %v", err)
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}

// toModel copies the domain result into the GraphQL models without inventing
// empty values.
func toModel(result domain.TranslateResult) TranslateRssItemsPayloadModel {
	translations := make([]RssItemTranslationModel, 0, len(result.Translations))
	for _, item := range result.Translations {
		model := RssItemTranslationModel{
			ItemID:          item.ItemID,
			Title:           item.Title,
			Summary:         item.Summary,
			CleanedMarkdown: item.CleanedMarkdown,
		}
		if item.KeyPoints != nil {
			points := append([]string{}, (*item.KeyPoints)...)
			model.KeyPoints = &points
		}
		translations = append(translations, model)
	}
	return TranslateRssItemsPayloadModel{
		Provider:       string(result.Provider),
		TargetLanguage: result.TargetLanguage,
		Translations:   translations,
	}
}
