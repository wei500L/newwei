package accountdata

import (
	"context"
	"fmt"
	"math"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// MaxAvatarBytes is the 2 MB limit enforced by StorageService.createAvatarUploadUrl.
const MaxAvatarBytes = 2 * 1024 * 1024

// avatarContentTypes maps the accepted MIME types onto the object-key
// extension, exactly like StorageService.ALLOWED_CONTENT_TYPES.
var avatarContentTypes = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

// AvatarUploadResponse is the 201 body shape of the presign route.
type AvatarUploadResponse struct {
	UploadURL string `json:"uploadUrl"`
	PublicURL string `json:"publicUrl"`
	ObjectKey string `json:"objectKey"`
}

// CreateAvatarUploadURL signs one avatar PUT for the caller.
//
// The evaluation order is the one NestJS's StorageService uses: resolve and
// check the storage configuration first, then the content type, then the size.
// An incomplete configuration therefore wins over an unsupported type, which is
// the order the controller reaches after the DTO shape checks.
func (s *Service) CreateAvatarUploadURL(ctx context.Context, orgID, userID, contentType string, contentLength float64) (AvatarUploadResponse, error) {
	if s == nil || s.storage == nil {
		return AvatarUploadResponse{}, &httpError{status: 503, message: "Storage configuration is unavailable"}
	}
	cfg, err := s.storage.StorageRuntimeConfig(ctx)
	if err != nil {
		return AvatarUploadResponse{}, dbWrap(err)
	}
	if !cfg.Complete() {
		return AvatarUploadResponse{}, badRequest(objectstorage.ErrIncompleteConfig.Error())
	}

	extension, ok := avatarContentTypes[contentType]
	if !ok {
		return AvatarUploadResponse{}, badRequest("Unsupported avatar content type")
	}
	// @IsInt from AvatarPresignRequestDto runs before the service checks in
	// NestJS; a fractional size can never be uploaded anyway.
	if !math.IsInf(contentLength, 0) && !math.IsNaN(contentLength) &&
		math.Trunc(contentLength) != contentLength {
		return AvatarUploadResponse{}, badRequest("contentLength must be an integer number")
	}
	if math.IsNaN(contentLength) || math.IsInf(contentLength, 0) || contentLength <= 0 {
		return AvatarUploadResponse{}, badRequest("Invalid avatar size")
	}
	if contentLength > MaxAvatarBytes {
		return AvatarUploadResponse{}, badRequest("Avatar exceeds 2MB size limit")
	}

	client, err := objectstorage.NewClient(cfg)
	if err != nil {
		return AvatarUploadResponse{}, badRequest(objectstorage.ErrIncompleteConfig.Error())
	}
	uuid, err := s.newUUID()
	if err != nil {
		return AvatarUploadResponse{}, fmt.Errorf("accountdata: generate avatar key: %w", err)
	}
	// Date.now() is a millisecond epoch and the uuid keeps concurrent uploads
	// of the same user from colliding.
	key := fmt.Sprintf("avatars/%s/%s/%d-%s.%s", orgID, userID, s.now().UnixMilli(), uuid, extension)
	uploadURL, err := client.CreateObjectUploadURL(ctx, key, objectstorage.UploadURLOptions{
		ContentType:   contentType,
		ContentLength: int64(contentLength),
	})
	if err != nil {
		return AvatarUploadResponse{}, fmt.Errorf("accountdata: sign avatar upload: %w", err)
	}

	return AvatarUploadResponse{
		UploadURL: uploadURL,
		PublicURL: cfg.NormalizedPublicBaseURL() + "/" + key,
		ObjectKey: key,
	}, nil
}
