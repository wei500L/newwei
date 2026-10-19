package itemsingestgraphql

import (
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
)

type createItemInput struct {
	Title      string
	ExternalID string
	Status     *string
	Payload    string
}

type updateItemInput struct {
	ID      string
	Title   *string
	Status  *string
	Payload *string
}

func failure(messages []string) error {
	return itemsingest.NewFailure(400, strings.Join(messages, "; "))
}

// parseCreateItemInput mirrors CreateItemInput's class-validator decorators:
// title/externalId MinLength(3), status optional string, payload non-empty
// string. The two identity fields are never trimmed.
func parseCreateItemInput(args map[string]any) (createItemInput, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return createItemInput{}, failure([]string{"input must be an object"})
	}
	messages := make([]string, 0, 6)
	title := requiredString(raw, "title", 3, true, &messages)
	externalID := requiredString(raw, "externalId", 3, true, &messages)
	status := optionalString(raw, "status", 0, &messages)
	payload := requiredPayloadString(raw, &messages)
	if len(messages) > 0 {
		return createItemInput{}, failure(messages)
	}
	return createItemInput{Title: title, ExternalID: externalID, Status: status, Payload: payload}, nil
}

// parseUpdateItemInput mirrors UpdateItemInput: id string, optional title with
// MaxLength(255), optional status string and optional payload string.
func parseUpdateItemInput(args map[string]any) (updateItemInput, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return updateItemInput{}, failure([]string{"input must be an object"})
	}
	messages := make([]string, 0, 6)
	id := requiredString(raw, "id", 0, false, &messages)
	title := optionalString(raw, "title", 255, &messages)
	status := optionalString(raw, "status", 0, &messages)
	payload := optionalString(raw, "payload", 0, &messages)
	if len(messages) > 0 {
		return updateItemInput{}, failure(messages)
	}
	return updateItemInput{ID: id, Title: title, Status: status, Payload: payload}, nil
}

// requiredString reports the class-validator messages in decorator application
// order. minLength adds the MinLength message; maxLength adds MaxLength.
func requiredString(input map[string]any, name string, minLength int, minLengthEnabled bool, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		if minLengthEnabled {
			*messages = append(*messages, minLengthMessage(name, minLength))
		}
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	text, ok := value.(string)
	if !ok {
		if minLengthEnabled {
			*messages = append(*messages, minLengthMessage(name, minLength))
		}
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	if minLengthEnabled && len(text) < minLength {
		*messages = append(*messages, minLengthMessage(name, minLength))
	}
	return text
}

func optionalString(input map[string]any, name string, maxLength int, messages *[]string) *string {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgNull || state == contract.ArgMissing {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		if maxLength > 0 {
			*messages = append(*messages, maxLengthMessage(name, maxLength))
		}
		*messages = append(*messages, name+" must be a string")
		return nil
	}
	if maxLength > 0 && len(text) > maxLength {
		*messages = append(*messages, maxLengthMessage(name, maxLength))
	}
	copied := text
	return &copied
}

func minLengthMessage(name string, min int) string {
	return fmt.Sprintf("%s must be longer than or equal to %d characters", name, min)
}

func maxLengthMessage(name string, max int) string {
	return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
}

// requiredPayloadString keeps the IsNotEmpty + IsString pair for the create
// payload. GraphQL rejects a missing non-null argument before the resolver, so
// this only reports an empty string or a wrong runtime type.
func requiredPayloadString(input map[string]any, messages *[]string) string {
	value, state := contract.Lookup(input, "payload")
	if state != contract.ArgValue {
		*messages = append(*messages, "payload should not be empty")
		*messages = append(*messages, "payload must be a string")
		return ""
	}
	text, ok := value.(string)
	if !ok || text == "" {
		*messages = append(*messages, "payload should not be empty")
	}
	if !ok {
		*messages = append(*messages, "payload must be a string")
		return ""
	}
	return text
}
