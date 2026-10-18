package identityonboarding

import (
	"bytes"
	"encoding/json"
	"errors"
)

// This file reproduces the global ValidationPipe (whitelist + forbidNonWhitelisted
// + transform) for the six request DTOs. The messages, their order and the
// treatment of absent / null / empty members are the contract: a client that
// switches between Go and NestJS must not be able to observe which one answered.
//
// Ordering rule copied from the existing ports: unknown members are reported
// before any field problem, properties follow declaration order, and a property
// with several decorators reports them bottom-up.

// decodeObject streams a JSON object body and feeds each member to the target,
// returning the undeclared member names in body order. A JSON null body is
// treated as an empty object, exactly like ValidationPipe.toEmptyIfNil.
func decodeObject(body []byte, target func(name string, value json.RawMessage) bool) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		return nil, errInvalidBody
	}
	if token == nil {
		return nil, nil
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, errInvalidBody
	}
	var unknown []string
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errInvalidBody
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, errInvalidBody
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, errInvalidBody
		}
		if !target(name, raw) {
			unknown = append(unknown, name)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errInvalidBody
	}
	return unknown, nil
}

// present reports whether a decoded field holds any JSON at all. An absent key
// leaves json.RawMessage nil; `null` is present with the four bytes "null".
func present(raw json.RawMessage) bool { return len(bytes.TrimSpace(raw)) > 0 }

func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// skippedOptional reports whether @IsOptional() short-circuits every decorator on
// the property (absent or null).
func skippedOptional(raw json.RawMessage) bool { return !present(raw) || isNull(raw) }

// decodeJSONString decodes a JSON string member. A non-string member reports
// ok=false without an error; the callers add the class-validator message.
func decodeJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// stringConstraint validates @IsString and appends its default message.
func stringConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return "", false
	}
	return text, true
}

// emailConstraint validates @IsEmail and appends its default message.
func emailConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := decodeJSONString(raw)
	if !ok || !validatorIsEmail(text) {
		v.add(field + " must be an email")
		return "", false
	}
	return text, true
}

// optionalStringConstraint validates @IsOptional() @IsString(). The returned
// pointer distinguishes an absent/null member (nil) from an explicit empty string
// (non-nil, ""), which the accept path depends on.
func optionalStringConstraint(v *validationErrors, raw json.RawMessage, field string) (*string, bool) {
	if skippedOptional(raw) {
		return nil, true
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return nil, false
	}
	return &text, true
}

// maxLengthConstraint validates @MaxLength on the validator.js code point count.
func maxLengthConstraint(v *validationErrors, raw json.RawMessage, field string, max int) *string {
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return nil
	}
	if jsLength(text) > max {
		v.add(field + " must be shorter than or equal to " + itoa(max) + " characters")
		return nil
	}
	return &text
}

// minLengthConstraint validates @MinLength on the validator.js code point count.
func minLengthConstraint(v *validationErrors, raw json.RawMessage, field string, min int) bool {
	text, ok := decodeJSONString(raw)
	if !ok || jsLength(text) < min {
		v.add(field + " must be longer than or equal to " + itoa(min) + " characters")
		return false
	}
	return true
}

// errMalformedRoleIDs reports an element of roleIds that is not a string. The
// source DTO validates only that roleIds is a non-empty array, and the service's
// .trim() call then fails, so NestJS answers 500; that is mirrored here instead
// of inventing a 400 rule.
var errMalformedRoleIDs = errors.New("identityonboarding: roleIds contains a non-string element")

// stringArrayConstraint validates @IsArray() @ArrayNotEmpty() and decodes the
// elements. Element types are not validated by the DTO.
func stringArrayConstraint(v *validationErrors, raw json.RawMessage, field string) ([]string, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		v.add(field + " must be an array")
		return nil, false, nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(trimmed, &elements); err != nil {
		v.add(field + " must be an array")
		return nil, false, nil
	}
	if len(elements) == 0 {
		v.add(field + " should not be empty")
		return nil, false, nil
	}
	values := make([]string, 0, len(elements))
	for _, element := range elements {
		text, ok := decodeJSONString(element)
		if !ok {
			return nil, false, errMalformedRoleIDs
		}
		values = append(values, text)
	}
	return values, true, nil
}

// ---- CreateInviteDto ----

type createInviteRequest struct {
	Email         string
	FirstName     *string
	LastName      *string
	PrimaryRoleID string
	RoleIDs       []string
}

func parseCreateInviteRequest(body []byte) (createInviteRequest, error) {
	var request createInviteRequest
	var emailRaw, firstNameRaw, lastNameRaw, primaryRoleRaw, roleIDsRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "email":
			emailRaw = value
		case "firstName":
			firstNameRaw = value
		case "lastName":
			lastNameRaw = value
		case "primaryRoleId":
			primaryRoleRaw = value
		case "roleIds":
			roleIDsRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	email, _ := emailConstraint(&problems, emailRaw, "email")
	var firstName *string
	if !skippedOptional(firstNameRaw) {
		firstName = maxLengthConstraint(&problems, firstNameRaw, "firstName", 120)
	}
	var lastName *string
	if !skippedOptional(lastNameRaw) {
		lastName = maxLengthConstraint(&problems, lastNameRaw, "lastName", 120)
	}
	primaryRoleID, _ := stringConstraint(&problems, primaryRoleRaw, "primaryRoleId")
	roleIDs, _, arrayErr := stringArrayConstraint(&problems, roleIDsRaw, "roleIds")
	if arrayErr != nil {
		return request, arrayErr
	}
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	request.FirstName = firstName
	request.LastName = lastName
	request.PrimaryRoleID = primaryRoleID
	request.RoleIDs = roleIDs
	return request, nil
}

// ---- ApproveJoinApplicationDto ----

type approveJoinRequest struct {
	PrimaryRoleID string
	RoleIDs       []string
}

func parseApproveJoinRequest(body []byte) (approveJoinRequest, error) {
	var request approveJoinRequest
	var primaryRoleRaw, roleIDsRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "primaryRoleId":
			primaryRoleRaw = value
		case "roleIds":
			roleIDsRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	primaryRoleID, _ := stringConstraint(&problems, primaryRoleRaw, "primaryRoleId")
	roleIDs, _, arrayErr := stringArrayConstraint(&problems, roleIDsRaw, "roleIds")
	if arrayErr != nil {
		return request, arrayErr
	}
	if err := problems.err(); err != nil {
		return request, err
	}
	request.PrimaryRoleID = primaryRoleID
	request.RoleIDs = roleIDs
	return request, nil
}

// ---- RejectApplicationDto ----

type rejectApplicationRequest struct {
	Reason *string
}

func parseRejectApplicationRequest(body []byte) (rejectApplicationRequest, error) {
	var request rejectApplicationRequest
	var reasonRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		if name != "reason" {
			return false
		}
		reasonRaw = value
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	reason, _ := optionalStringConstraint(&problems, reasonRaw, "reason")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Reason = reason
	return request, nil
}

// ---- SubmitNewOrgApplicationDto ----

type submitNewOrgRequest struct {
	Email       string
	FirstName   string
	LastName    string
	OrgName     string
	OrgSlug     string
	Description *string
}

func parseSubmitNewOrgRequest(body []byte) (submitNewOrgRequest, error) {
	var request submitNewOrgRequest
	var emailRaw, firstNameRaw, lastNameRaw, orgNameRaw, orgSlugRaw, descriptionRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "email":
			emailRaw = value
		case "firstName":
			firstNameRaw = value
		case "lastName":
			lastNameRaw = value
		case "orgName":
			orgNameRaw = value
		case "orgSlug":
			orgSlugRaw = value
		case "description":
			descriptionRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	email, _ := emailConstraint(&problems, emailRaw, "email")
	firstName, _ := stringConstraint(&problems, firstNameRaw, "firstName")
	lastName, _ := stringConstraint(&problems, lastNameRaw, "lastName")
	orgName, _ := stringConstraint(&problems, orgNameRaw, "orgName")
	orgSlug, _ := stringConstraint(&problems, orgSlugRaw, "orgSlug")
	description, _ := optionalStringConstraint(&problems, descriptionRaw, "description")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	request.FirstName = firstName
	request.LastName = lastName
	request.OrgName = orgName
	request.OrgSlug = orgSlug
	request.Description = description
	return request, nil
}

// ---- SubmitJoinOrgApplicationDto ----

type submitJoinOrgRequest struct {
	Email     string
	FirstName string
	LastName  string
	OrgSlug   string
}

func parseSubmitJoinOrgRequest(body []byte) (submitJoinOrgRequest, error) {
	var request submitJoinOrgRequest
	var emailRaw, firstNameRaw, lastNameRaw, orgSlugRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "email":
			emailRaw = value
		case "firstName":
			firstNameRaw = value
		case "lastName":
			lastNameRaw = value
		case "orgSlug":
			orgSlugRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	email, _ := emailConstraint(&problems, emailRaw, "email")
	firstName, _ := stringConstraint(&problems, firstNameRaw, "firstName")
	lastName, _ := stringConstraint(&problems, lastNameRaw, "lastName")
	orgSlug, _ := stringConstraint(&problems, orgSlugRaw, "orgSlug")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	request.FirstName = firstName
	request.LastName = lastName
	request.OrgSlug = orgSlug
	return request, nil
}

// ---- AcceptInviteDto ----

type acceptInviteRequest struct {
	Password  *string
	FirstName *string
	LastName  *string
}

func parseAcceptInviteRequest(body []byte) (acceptInviteRequest, error) {
	var request acceptInviteRequest
	var passwordRaw, firstNameRaw, lastNameRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "password":
			passwordRaw = value
		case "firstName":
			firstNameRaw = value
		case "lastName":
			lastNameRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	var password *string
	if !skippedOptional(passwordRaw) {
		minLengthConstraint(&problems, passwordRaw, "password", 8)
		if text, ok := decodeJSONString(passwordRaw); ok {
			password = &text
		} else {
			problems.add("password must be a string")
		}
	}
	firstName, _ := optionalStringConstraint(&problems, firstNameRaw, "firstName")
	lastName, _ := optionalStringConstraint(&problems, lastNameRaw, "lastName")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Password = password
	request.FirstName = firstName
	request.LastName = lastName
	return request, nil
}

// itoa renders a small non-negative integer without pulling strconv into the
// validation helpers.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
