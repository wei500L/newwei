package mongodb

import (
	"strings"
	"testing"
)

// TestParseMongoDatabaseDoesNotLeakURI is moved from dashboardstats: the URI
// parser lives here now, so its no-leak contract is tested here.
func TestParseMongoDatabaseDoesNotLeakURI(t *testing.T) {
	secret := "s3cret-password"
	cases := []string{
		"http://user:" + secret + "@localhost/app",
		"mongodb://user:" + secret + "@localhost:27017",
		"mongodb://user:" + secret + "@localhost:27017/app/extra",
		"not a uri " + secret,
	}
	for _, uri := range cases {
		if _, err := parseMongoDatabase(uri); err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "localhost") {
			t.Fatalf("uri rejected badly: err=%v", err)
		}
	}
	name, err := parseMongoDatabase("mongodb://user:" + secret + "@mongo:27017/app?authSource=admin")
	if err != nil || name != "app" {
		t.Fatalf("db = %q err=%v", name, err)
	}
}
