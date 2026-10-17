package infrastructuresettings

import "encoding/json"

// storageSettingsRequest is the PATCH /api/admin/settings/storage body.
//
// Every property carries @IsOptional(), so an absent or null value skips that
// property's constraints entirely; the service layer keeps the per-field
// clearing semantics. Declaration order (and therefore message order) is:
//
//	crawlImageStorage (@IsIn mysql|s3),
//	accessKeyId, secretAccessKey, region, bucket (@IsString),
//	endpoint, publicBaseUrl (@IsUrl require_protocol),
//	forcePathStyle (@IsBoolean),
//	presignedUrlTtlSeconds (@IsInt @Min(30) @Max(3600)).
type storageSettingsRequest struct {
	CrawlImageStorageRaw      json.RawMessage
	AccessKeyIDRaw            json.RawMessage
	SecretAccessKeyRaw        json.RawMessage
	RegionRaw                 json.RawMessage
	BucketRaw                 json.RawMessage
	EndpointRaw               json.RawMessage
	PublicBaseURLRaw          json.RawMessage
	ForcePathStyleRaw         json.RawMessage
	PresignedURLTTLSecondsRaw json.RawMessage
}

// setField records one declared member.
func (d *storageSettingsRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "crawlImageStorage":
		d.CrawlImageStorageRaw = value
	case "accessKeyId":
		d.AccessKeyIDRaw = value
	case "secretAccessKey":
		d.SecretAccessKeyRaw = value
	case "region":
		d.RegionRaw = value
	case "bucket":
		d.BucketRaw = value
	case "endpoint":
		d.EndpointRaw = value
	case "publicBaseUrl":
		d.PublicBaseURLRaw = value
	case "forcePathStyle":
		d.ForcePathStyleRaw = value
	case "presignedUrlTtlSeconds":
		d.PresignedURLTTLSecondsRaw = value
	default:
		return false
	}
	return true
}

// parseStorageSettingsRequest mirrors ValidationPipe for
// UpdateStorageSettingsDto.
func parseStorageSettingsRequest(body []byte) (storageSettingsRequest, error) {
	dto := storageSettingsRequest{}
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return storageSettingsRequest{}, err
	}

	problems := validationErrors{}
	for _, name := range unknown {
		problems.add(unknownPropertyMessage(name))
	}
	if !skippedOptional(dto.CrawlImageStorageRaw) {
		// @IsIn runs alone: the property has no @IsString.
		enumConstraint(&problems, dto.CrawlImageStorageRaw, "crawlImageStorage", crawlImageStorageProviders)
	}
	optionalStringConstraint(&problems, dto.AccessKeyIDRaw, "accessKeyId")
	optionalStringConstraint(&problems, dto.SecretAccessKeyRaw, "secretAccessKey")
	optionalStringConstraint(&problems, dto.RegionRaw, "region")
	optionalStringConstraint(&problems, dto.BucketRaw, "bucket")
	if !skippedOptional(dto.EndpointRaw) {
		urlConstraint(&problems, dto.EndpointRaw, "endpoint")
	}
	if !skippedOptional(dto.PublicBaseURLRaw) {
		urlConstraint(&problems, dto.PublicBaseURLRaw, "publicBaseUrl")
	}
	if !skippedOptional(dto.ForcePathStyleRaw) {
		boolConstraint(&problems, dto.ForcePathStyleRaw, "forcePathStyle", false)
	}
	if !skippedOptional(dto.PresignedURLTTLSecondsRaw) {
		maxMinIntConstraint(&problems, dto.PresignedURLTTLSecondsRaw, "presignedUrlTtlSeconds", 30, 3600)
	}

	if err := problems.err(); err != nil {
		return storageSettingsRequest{}, err
	}
	return dto, nil
}
