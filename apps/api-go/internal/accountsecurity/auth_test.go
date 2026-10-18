package accountsecurity

import (
	"net/http"
	"testing"
)

// TestMachinePermissionStringsKeepsHistoricalPermissions locks the
// authentication boundary: stored permissions are narrowed to strings only.
// They are never re-filtered through the create-time whitelist, trimmed or
// deduplicated, so a historical settings.manage token keeps its access.
func TestMachinePermissionStringsKeepsHistoricalPermissions(t *testing.T) {
	got := machinePermissionStrings([]byte(`["settings.manage"," metrics.read ",3,null,"settings.manage"]`))
	want := []string{"settings.manage", " metrics.read ", "settings.manage"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for index := range got {
		if got[index] != want[index] {
			t.Fatalf("got %v want %v", got, want)
		}
	}

	if got := machinePermissionStrings([]byte(`{"settings.manage":true}`)); len(got) != 0 {
		t.Fatalf("non-array = %v", got)
	}
	if got := machinePermissionStrings(nil); len(got) != 0 {
		t.Fatalf("nil = %v", got)
	}
}

func TestRawBearerExtraction(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   string
	}{
		{"missing", "", ""},
		{"wrong scheme", "Basic abc", ""},
		{"machine token kept", "Bearer mtk_abc", "mtk_abc"},
		{"lowercase scheme", "bearer jwt-value", "jwt-value"},
		{"extra whitespace", "Bearer   jwt-value  ", "jwt-value"},
	}
	for _, testCase := range cases {
		request, err := http.NewRequest(http.MethodGet, "http://gateway/api/auth/me", nil)
		if err != nil {
			t.Fatal(err)
		}
		if testCase.header != "" {
			request.Header.Set("Authorization", testCase.header)
		}
		if got := rawBearer(request); got != testCase.want {
			t.Fatalf("%s: rawBearer = %q want %q", testCase.name, got, testCase.want)
		}
	}
}

func TestNullableActorID(t *testing.T) {
	if got := nullableActorID(""); got != nil {
		t.Fatalf("empty = %v", *got)
	}
	if got := nullableActorID("machine:mtk_1"); got != nil {
		t.Fatalf("machine = %v", *got)
	}
	got := nullableActorID("user-1")
	if got == nil || *got != "user-1" {
		t.Fatalf("human = %v", got)
	}
}
