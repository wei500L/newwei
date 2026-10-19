package accountdata

import (
	"context"
	"errors"
	"math"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

type fakeStorageConfig struct {
	config objectstorage.RuntimeConfig
	err    error
}

func (f fakeStorageConfig) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return f.config, f.err
}

const fixedMillis int64 = 1700000000123

func avatarTestConfig() objectstorage.RuntimeConfig {
	return objectstorage.RuntimeConfig{
		AccessKeyID:            "test-access-key",
		SecretAccessKey:        "test-secret-key",
		Region:                 "us-east-1",
		Bucket:                 "my-bucket",
		Endpoint:               "http://minio.local:9000",
		PublicBaseURL:          "http://cdn.local/my-bucket/",
		ForcePathStyle:         true,
		PresignedURLTTLSeconds: 300,
	}
}

func TestCreateAvatarUploadURLBuildsKey(t *testing.T) {
	service := NewService(Options{
		Storage: fakeStorageConfig{config: avatarTestConfig()},
		Now:     func() time.Time { return time.UnixMilli(fixedMillis).UTC() },
		NewUUID: func() (string, error) {
			return "2f8f6a5e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", nil
		},
	})
	response, err := service.CreateAvatarUploadURL(context.Background(), "org-1", "user-1", "image/png", 1024)
	if err != nil {
		t.Fatalf("CreateAvatarUploadURL: %v", err)
	}
	wantKey := "avatars/org-1/user-1/1700000000123-2f8f6a5e-3c4d-4e5f-8a9b-0c1d2e3f4a5b.png"
	if response.ObjectKey != wantKey {
		t.Fatalf("objectKey = %q, want %q", response.ObjectKey, wantKey)
	}
	if response.PublicURL != "http://cdn.local/my-bucket/"+wantKey {
		t.Fatalf("publicUrl = %q", response.PublicURL)
	}
	parsed, err := url.Parse(response.UploadURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	signedHeaders := query.Get("X-Amz-SignedHeaders")
	if !containsHeader(signedHeaders, "content-type") || !containsHeader(signedHeaders, "content-length") {
		t.Fatalf("signed headers = %q, want content-type and content-length", signedHeaders)
	}
	if parsed.Query().Get("X-Amz-Expires") != "300" {
		t.Fatalf("X-Amz-Expires = %q", parsed.Query().Get("X-Amz-Expires"))
	}
}

func TestCreateAvatarUploadURLValidationOrderAndMessages(t *testing.T) {
	incomplete := avatarTestConfig()
	incomplete.Bucket = ""
	cases := []struct {
		name          string
		config        objectstorage.RuntimeConfig
		contentType   string
		contentLength float64
		wantMessage   string
	}{
		// Configuration wins over an unsupported type: StorageService refreshes
		// the client before it looks at the DTO values.
		{"config before type", incomplete, "image/gif", 1024, "Storage configuration is incomplete"},
		{"unsupported type", avatarTestConfig(), "image/gif", 1024, "Unsupported avatar content type"},
		{"jpeg is accepted", avatarTestConfig(), "image/jpeg", 1024, ""},
		{"zero size", avatarTestConfig(), "image/png", 0, "Invalid avatar size"},
		{"negative size", avatarTestConfig(), "image/png", -1, "Invalid avatar size"},
		{"fractional size", avatarTestConfig(), "image/png", 1.5, "contentLength must be an integer number"},
		{"nan size", avatarTestConfig(), "image/png", math.NaN(), "Invalid avatar size"},
		{"infinite size", avatarTestConfig(), "image/png", math.Inf(1), "Invalid avatar size"},
		{"too large", avatarTestConfig(), "image/png", MaxAvatarBytes + 1, "Avatar exceeds 2MB size limit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := NewService(Options{Storage: fakeStorageConfig{config: tc.config}})
			_, err := service.CreateAvatarUploadURL(context.Background(), "org-1", "user-1", tc.contentType, tc.contentLength)
			if tc.wantMessage == "" {
				if err != nil {
					t.Fatalf("err = %v, want success", err)
				}
				return
			}
			var coded *httpError
			if !errors.As(err, &coded) || coded.status != 400 {
				t.Fatalf("err = %v, want 400", err)
			}
			if coded.message != tc.wantMessage {
				t.Fatalf("message = %q, want %q", coded.message, tc.wantMessage)
			}
		})
	}
}

// containsHeader is shared with the objectstorage round-trip test only by
// intent; the package-local copy keeps the two test packages independent.
func containsHeader(list, want string) bool {
	for _, name := range strings.Split(list, ";") {
		if name == want {
			return true
		}
	}
	return false
}
