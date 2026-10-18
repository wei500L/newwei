package accountsecurity

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
)

// profileFakeDB returns a state whose User lookup succeeds and whose
// SystemSetting lookup is empty (so the S3_* environment defaults apply).
func profileFakeDB(ownerExists bool) *fakeState {
	return &fakeState{
		queryHandler: func(query string, _ []driver.NamedValue) (driver.Rows, error) {
			switch {
			case strings.Contains(query, "FROM `User`"):
				if !ownerExists {
					return &fakeRows{columns: []string{"id"}}, nil
				}
				return rowsWithValues([]string{"id"}, testUserID), nil
			case strings.Contains(query, "FROM SystemSetting"):
				return &fakeRows{columns: []string{"key", "value"}}, nil
			default:
				return nil, errors.New("unexpected query: " + query)
			}
		},
	}
}

func storageConfigForTest() Config {
	return Config{
		S3AccessKeyID:            "access-key",
		S3SecretAccessKey:        "secret-key",
		S3Region:                 "us-east-1",
		S3Bucket:                 "avatars",
		S3PublicBaseURL:          "https://cdn.example.com/",
		S3ForcePathStyle:         false,
		S3PresignedURLTTLSeconds: 300,
	}
}

// TestUpdateProfileNullIsAnEmptyFieldError covers AS3: an explicit JSON null
// must not reach a trim (TypeError -> 500) and must not write anything.
func TestUpdateProfileNullIsAnEmptyFieldError(t *testing.T) {
	cases := []struct {
		name    string
		request updateProfileRequest
		message string
	}{
		{"first null", updateProfileRequest{FirstName: []byte("null")}, "First name cannot be empty"},
		{"first blank", updateProfileRequest{FirstName: []byte(`"   "`)}, "First name cannot be empty"},
		{"last null", updateProfileRequest{LastName: []byte("null")}, "Last name cannot be empty"},
		{"last blank", updateProfileRequest{LastName: []byte(`"  "`)}, "Last name cannot be empty"},
		{"avatar null", updateProfileRequest{AvatarURL: []byte("null")}, "Avatar URL cannot be empty"},
		{"avatar blank", updateProfileRequest{AvatarURL: []byte(`" "`)}, "Avatar URL cannot be empty"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			state := profileFakeDB(true)
			service := NewService(newFakeDB(state), nil, storageConfigForTest())
			_, err := service.updateProfile(context.Background(), testUserID, testOrgID, testCase.request)
			wantBadRequest(t, err, testCase.message)
			if statements := state.executedStatements(); len(statements) != 0 {
				t.Fatalf("partial write: %v", statements)
			}
		})
	}
}

// TestUpdateProfileMachineIdentityIsUnauthorized covers the AS3 machine path:
// machine:<tokenId> is not a User row, so the response is 401 rather than a
// Prisma missing-record 500 — including for an empty body.
func TestUpdateProfileMachineIdentityIsUnauthorized(t *testing.T) {
	state := profileFakeDB(false)
	service := NewService(newFakeDB(state), nil, storageConfigForTest())
	_, err := service.updateProfile(context.Background(), "machine:mtk_1", testOrgID, updateProfileRequest{})
	var coded *httpError
	if !errors.As(err, &coded) || coded.status != 401 || coded.message != "Invalid access token" {
		t.Fatalf("err = %v", err)
	}
	if statements := state.executedStatements(); len(statements) != 0 {
		t.Fatalf("machine identity wrote a row: %v", statements)
	}
}

// TestUpdateProfileFieldOrderAndNoPartialWrite covers the service field order:
// firstName before lastName before avatarUrl, with no write on any failure.
func TestUpdateProfileFieldOrderAndNoPartialWrite(t *testing.T) {
	state := profileFakeDB(true)
	service := NewService(newFakeDB(state), nil, storageConfigForTest())
	_, err := service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{
		FirstName: []byte(`"  "`),
		LastName:  []byte(`"ok"`),
		AvatarURL: []byte(`"https://example.com/a.png"`),
	})
	wantBadRequest(t, err, "First name cannot be empty")
	if statements := state.executedStatements(); len(statements) != 0 {
		t.Fatalf("partial write: %v", statements)
	}
}

// TestUpdateProfileRejectsAvatarOutsideStorageBase covers the avatar storage
// read: an incomplete configuration and a value outside the public base URL are
// both 400, and no S3/HTTP call is made.
func TestUpdateProfileRejectsAvatarOutsideStorageBase(t *testing.T) {
	state := profileFakeDB(true)
	service := NewService(newFakeDB(state), nil, storageConfigForTest())
	_, err := service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{
		AvatarURL: []byte(`"https://evil.example.com/avatars/x.png"`),
	})
	wantBadRequest(t, err, "Avatar URL must use the approved storage base URL")

	// A same-hostname but non-prefix URL is also rejected (no loose suffix
	// matching).
	_, err = service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{
		AvatarURL: []byte(`"https://cdn.example.com.evil.test/a.png"`),
	})
	wantBadRequest(t, err, "Avatar URL must use the approved storage base URL")

	incomplete := storageConfigForTest()
	incomplete.S3Bucket = ""
	service = NewService(newFakeDB(profileFakeDB(true)), nil, incomplete)
	_, err = service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{
		AvatarURL: []byte(`"https://cdn.example.com/avatars/x.png"`),
	})
	wantBadRequest(t, err, "Storage configuration is incomplete")
}

// TestUpdateProfileTrimsAndWritesOnce proves the happy path writes exactly one
// UPDATE with the trimmed value, and that the trailing cache invalidation is the
// only step that needs Redis.
func TestUpdateProfileTrimsAndWritesOnce(t *testing.T) {
	state := profileFakeDB(true)
	var updateArgs []driver.NamedValue
	state.execHandler = func(query string, args []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "UPDATE `User`") {
			updateArgs = args
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, storageConfigForTest())

	_, err := service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{
		FirstName: []byte(`"  Ada  "`),
		LastName:  []byte(`"Lovelace"`),
		AvatarURL: []byte(`"https://cdn.example.com/avatars/ada.png"`),
	})
	if err != nil && !errors.Is(err, errNoRedis) {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := namedArg(updateArgs, 1); got != "Ada" {
		t.Fatalf("firstName = %#v", got)
	}
	if got := namedArg(updateArgs, 2); got != "Lovelace" {
		t.Fatalf("lastName = %#v", got)
	}
	if got := namedArg(updateArgs, 3); got != "https://cdn.example.com/avatars/ada.png" {
		t.Fatalf("avatarUrl = %#v", got)
	}
	writes := 0
	for _, statement := range state.executedStatements() {
		if strings.Contains(statement, "UPDATE `User`") {
			writes++
		}
	}
	if writes != 1 {
		t.Fatalf("writes = %d", writes)
	}
}

// TestUpdateProfileEmptyBodyNeverWrites covers the no-op contract: an empty body
// goes down the cached read path and never touches User.updatedAt.
func TestUpdateProfileEmptyBodyNeverWrites(t *testing.T) {
	state := profileFakeDB(true)
	service := NewService(newFakeDB(state), nil, storageConfigForTest())
	_, err := service.updateProfile(context.Background(), testUserID, testOrgID, updateProfileRequest{})
	if err == nil || !errors.Is(err, errNoRedis) {
		t.Fatalf("expected the read path to need Redis, got %v", err)
	}
	for _, statement := range state.executedStatements() {
		if strings.Contains(statement, "UPDATE `User`") {
			t.Fatalf("empty body wrote: %s", statement)
		}
	}
}
