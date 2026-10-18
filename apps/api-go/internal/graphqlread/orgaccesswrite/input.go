package orgaccesswrite

import (
	"fmt"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// The argument objects arrive as the executor's coerced GraphQL values, which
// is the protocol boundary: everything is converted into the named structs
// below before any business logic runs.
//
// The class-validator message order follows the decorator application order,
// which is the reverse of the source order in the NestJS DTO. Properties are
// reported in source order.

const slugFormatMessage = "Slug must contain letters, numbers, and hyphens (e.g. acme-corp)"

// createOrgInput is a validated CreateOrgInput.
type createOrgInput struct {
	Name        string
	Slug        string
	Description *string
}

// updateOrgInput is a validated UpdateOrgInput. Present distinguishes an
// omitted property from an explicit null.
type updateOrgInput struct {
	ID                 string
	Name               *string
	NamePresent        bool
	Slug               *string
	SlugPresent        bool
	Description        *string
	DescriptionPresent bool
}

// setOrgActiveInput is a validated SetOrgActiveInput.
type setOrgActiveInput struct {
	ID       string
	IsActive bool
}

// createRoleInput is a validated CreateRoleInput.
type createRoleInput struct {
	Name        string
	Description *string
	Permissions []string
}

// updateRoleInput is a validated UpdateRoleInput.
type updateRoleInput struct {
	ID          string
	Description *string
	Permissions []string
}

// assignRoleInput is a validated AssignRoleInput.
type assignRoleInput struct {
	UserID string
	RoleID string
}

// updateMembershipRolesInput is a validated UpdateMembershipRolesInput.
type updateMembershipRolesInput struct {
	UserID        string
	PrimaryRoleID string
	RoleIDs       []string
}

// setUserActiveInput is a validated SetUserActiveInput.
type setUserActiveInput struct {
	UserID   string
	IsActive bool
}

func parseCreateOrgInput(args map[string]any) (createOrgInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return createOrgInput{}, err
	}
	messages := []string{}
	name := requiredString(raw, "name", 120, &messages)
	slug := requiredSlug(raw, "slug", 64, &messages)
	description, _ := optionalString(raw, "description", 500, &messages)
	if len(messages) > 0 {
		return createOrgInput{}, newInputFailure(messages)
	}
	return createOrgInput{Name: name, Slug: slug, Description: description}, nil
}

func parseUpdateOrgInput(args map[string]any) (updateOrgInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateOrgInput{}, err
	}
	messages := []string{}
	id := requiredString(raw, "id", 0, &messages)
	name, namePresent := optionalString(raw, "name", 120, &messages)
	slug, slugPresent := optionalSlug(raw, "slug", 64, &messages)
	description, descriptionPresent := optionalString(raw, "description", 500, &messages)
	if len(messages) > 0 {
		return updateOrgInput{}, newInputFailure(messages)
	}
	return updateOrgInput{
		ID:                 id,
		Name:               name,
		NamePresent:        namePresent,
		Slug:               slug,
		SlugPresent:        slugPresent,
		Description:        description,
		DescriptionPresent: descriptionPresent,
	}, nil
}

func parseSetOrgActiveInput(args map[string]any) (setOrgActiveInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return setOrgActiveInput{}, err
	}
	messages := []string{}
	id := requiredString(raw, "id", 0, &messages)
	isActive := requiredBool(raw, "isActive", &messages)
	if len(messages) > 0 {
		return setOrgActiveInput{}, newInputFailure(messages)
	}
	return setOrgActiveInput{ID: id, IsActive: isActive}, nil
}

func parseCreateRoleInput(args map[string]any) (createRoleInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return createRoleInput{}, err
	}
	messages := []string{}
	name := requiredString(raw, "name", 64, &messages)
	description, _ := optionalString(raw, "description", 0, &messages)
	permissions := requiredStringList(raw, "permissions", &messages)
	if len(messages) > 0 {
		return createRoleInput{}, newInputFailure(messages)
	}
	return createRoleInput{Name: name, Description: description, Permissions: permissions}, nil
}

func parseUpdateRoleInput(args map[string]any) (updateRoleInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateRoleInput{}, err
	}
	messages := []string{}
	id := requiredString(raw, "id", 0, &messages)
	description, _ := optionalString(raw, "description", 240, &messages)
	permissions := requiredStringList(raw, "permissions", &messages)
	if len(messages) > 0 {
		return updateRoleInput{}, newInputFailure(messages)
	}
	return updateRoleInput{ID: id, Description: description, Permissions: permissions}, nil
}

func parseAssignRoleInput(args map[string]any) (assignRoleInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return assignRoleInput{}, err
	}
	messages := []string{}
	userID := requiredString(raw, "userId", 0, &messages)
	roleID := requiredString(raw, "roleId", 0, &messages)
	if len(messages) > 0 {
		return assignRoleInput{}, newInputFailure(messages)
	}
	return assignRoleInput{UserID: userID, RoleID: roleID}, nil
}

func parseUpdateMembershipRolesInput(args map[string]any) (updateMembershipRolesInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateMembershipRolesInput{}, err
	}
	messages := []string{}
	userID := requiredString(raw, "userId", 0, &messages)
	primaryRoleID := requiredString(raw, "primaryRoleId", 0, &messages)
	roleIDs := requiredStringList(raw, "roleIds", &messages)
	if len(messages) > 0 {
		return updateMembershipRolesInput{}, newInputFailure(messages)
	}
	return updateMembershipRolesInput{UserID: userID, PrimaryRoleID: primaryRoleID, RoleIDs: roleIDs}, nil
}

func parseSetUserActiveInput(args map[string]any) (setUserActiveInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return setUserActiveInput{}, err
	}
	messages := []string{}
	userID := requiredString(raw, "userId", 0, &messages)
	isActive := requiredBool(raw, "isActive", &messages)
	if len(messages) > 0 {
		return setUserActiveInput{}, newInputFailure(messages)
	}
	return setUserActiveInput{UserID: userID, IsActive: isActive}, nil
}

func inputObject(args map[string]any) (map[string]any, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		// GraphQL rejects a missing or wrongly typed input before the resolver;
		// this mirrors the ValidationPipe failure shape for an untyped value.
		return nil, newInputFailure([]string{"input must be an object"})
	}
	return raw, nil
}

func maxLengthMessage(name string, max int) string {
	return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
}

// requiredString mirrors @IsString plus an optional @MaxLength. max <= 0 means
// the DTO declares no length constraint. The message order is MaxLength before
// IsString, which is the decorator application order.
func requiredString(input map[string]any, name string, max int, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		if max > 0 {
			*messages = append(*messages, maxLengthMessage(name, max))
		}
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	text, ok := value.(string)
	if !ok {
		if max > 0 {
			*messages = append(*messages, maxLengthMessage(name, max))
		}
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	if max > 0 && jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
		return ""
	}
	return text
}

// optionalString mirrors @IsOptional @IsString plus an optional @MaxLength. It
// reports whether the property was supplied; an explicit null is supplied with
// a nil value.
func optionalString(input map[string]any, name string, max int, messages *[]string) (*string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	text, ok := value.(string)
	if !ok {
		if max > 0 {
			*messages = append(*messages, maxLengthMessage(name, max))
		}
		*messages = append(*messages, name+" must be a string")
		return nil, true
	}
	if max > 0 && jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
		return nil, true
	}
	return &text, true
}

// requiredSlug mirrors @IsString @MaxLength(max) @Matches(slugPattern) and
// reports the messages in the decorator application order: Matches, MaxLength,
// IsString.
func requiredSlug(input map[string]any, name string, max int, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, slugFormatMessage, maxLengthMessage(name, max), name+" must be a string")
		return ""
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, slugFormatMessage, maxLengthMessage(name, max), name+" must be a string")
		return ""
	}
	if !slugPattern.MatchString(text) {
		*messages = append(*messages, slugFormatMessage)
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
	}
	return text
}

// optionalSlug is requiredSlug for @IsOptional fields.
func optionalSlug(input map[string]any, name string, max int, messages *[]string) (*string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, slugFormatMessage, maxLengthMessage(name, max), name+" must be a string")
		return nil, true
	}
	if !slugPattern.MatchString(text) {
		*messages = append(*messages, slugFormatMessage)
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
	}
	return &text, true
}

// requiredStringList mirrors @IsArray @ArrayNotEmpty on a [String!]! field.
func requiredStringList(input map[string]any, name string, messages *[]string) []string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" should not be empty", name+" must be an array")
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, name+" should not be empty", name+" must be an array")
		return nil
	}
	if len(items) == 0 {
		*messages = append(*messages, name+" should not be empty")
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in "+name+" must be a string")
			continue
		}
		out = append(out, text)
	}
	return out
}

// requiredBool mirrors @IsBoolean.
func requiredBool(input map[string]any, name string, messages *[]string) bool {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be a boolean value")
		return false
	}
	flag, ok := value.(bool)
	if !ok {
		*messages = append(*messages, name+" must be a boolean value")
		return false
	}
	return flag
}
