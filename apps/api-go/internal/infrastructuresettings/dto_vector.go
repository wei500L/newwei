package infrastructuresettings

import "encoding/json"

// vectorSettingsRequest is the PUT /api/system-settings/vector-service body.
//
// Fields keep their raw JSON so one wrong type never aborts the whole decode,
// and are validated in the DTO's declaration order:
//
//	enabled (required boolean), fallbackToMongo (required boolean),
//	baseUrl (optional string), token (optional string),
//	timeoutMs (required int, @IsInt then @Min(100)),
//	maxRetries (required int, @IsInt then @Min(0) then @Max(10)).
type vectorSettingsRequest struct {
	Enabled            bool
	FallbackToMongo    bool
	BaseURLRaw         json.RawMessage
	TokenRaw           json.RawMessage
	TimeoutMs          int
	MaxRetries         int
	enabledRaw         json.RawMessage
	fallbackToMongoRaw json.RawMessage
	timeoutMsRaw       json.RawMessage
	maxRetriesRaw      json.RawMessage
}

// setField records one declared member.
func (d *vectorSettingsRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "enabled":
		d.enabledRaw = value
	case "fallbackToMongo":
		d.fallbackToMongoRaw = value
	case "baseUrl":
		d.BaseURLRaw = value
	case "token":
		d.TokenRaw = value
	case "timeoutMs":
		d.timeoutMsRaw = value
	case "maxRetries":
		d.maxRetriesRaw = value
	default:
		return false
	}
	return true
}

// parseVectorSettingsRequest mirrors ValidationPipe(whitelist,
// forbidNonWhitelisted, transform) for UpdateVectorServiceSettingsDto.
func parseVectorSettingsRequest(body []byte) (vectorSettingsRequest, error) {
	dto := vectorSettingsRequest{}
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return vectorSettingsRequest{}, err
	}

	problems := validationErrors{}
	for _, name := range unknown {
		problems.add(unknownPropertyMessage(name))
	}
	dto.Enabled, _ = boolConstraint(&problems, dto.enabledRaw, "enabled", true)
	dto.FallbackToMongo, _ = boolConstraint(&problems, dto.fallbackToMongoRaw, "fallbackToMongo", true)
	optionalStringConstraint(&problems, dto.BaseURLRaw, "baseUrl")
	optionalStringConstraint(&problems, dto.TokenRaw, "token")
	dto.TimeoutMs, _ = minThenIntConstraint(&problems, dto.timeoutMsRaw, "timeoutMs", 100)
	dto.MaxRetries, _ = maxMinIntConstraint(&problems, dto.maxRetriesRaw, "maxRetries", 0, 10)

	if err := problems.err(); err != nil {
		return vectorSettingsRequest{}, err
	}
	return dto, nil
}

// optionalStringConstraint validates @IsOptional() plus @IsString(): absent or
// null values are skipped entirely.
func optionalStringConstraint(v *validationErrors, raw json.RawMessage, field string) bool {
	if skippedOptional(raw) {
		return true
	}
	_, ok := stringConstraint(v, raw, field, false)
	return ok
}

// unknownPropertyMessage is the class-validator whitelist message.
func unknownPropertyMessage(name string) string {
	return "property " + name + " should not exist"
}
