package situationmonitors

import (
	"database/sql"
	"testing"
)

// NestJS validates update fields with @IsOptional(), which skips JSON null, so
// `patch.x ?? existing.x` keeps the stored column. The Go decoder must not turn
// that into a validation error.
func TestUpdateKeepsStoredValuesOnNull(t *testing.T) {
	patch, err := validateUpdate([]byte(`{
		"name": null,
		"rawKeywords": null,
		"approvedTopics": null,
		"approvedEntities": null,
		"approvedLexicalTerms": null,
		"rejectedTopics": null,
		"rejectedEntities": null,
		"rejectedLexicalTerms": null,
		"enabled": null
	}`))
	if err != nil {
		t.Fatalf("validateUpdate = %v", err)
	}

	merged := mergePatch(monitorRow{
		Name:             "Kept",
		Enabled:          true,
		RawKeywords:      []byte(`["k"]`),
		ApprovedTopics:   []byte(`["t"]`),
		ApprovedEntities: []byte(`["e"]`),
		ApprovedLexical:  []byte(`["l"]`),
		Rejected:         []byte(`{"topics":["x"]}`),
	}, patch)

	if merged.Name != "Kept" {
		t.Fatalf("name = %q", merged.Name)
	}
	if len(merged.RawKeywords) != 1 || merged.RawKeywords[0] != "k" {
		t.Fatalf("rawKeywords = %v", merged.RawKeywords)
	}
	if len(merged.ApprovedTopics) != 1 || merged.ApprovedTopics[0] != "t" {
		t.Fatalf("approvedTopics = %v", merged.ApprovedTopics)
	}
	if len(merged.ApprovedEntities) != 1 || merged.ApprovedEntities[0] != "e" {
		t.Fatalf("approvedEntities = %v", merged.ApprovedEntities)
	}
	if len(merged.ApprovedLexical) != 1 || merged.ApprovedLexical[0] != "l" {
		t.Fatalf("approvedLexical = %v", merged.ApprovedLexical)
	}
	if len(merged.RejectedTopics) != 1 || merged.RejectedTopics[0] != "x" {
		t.Fatalf("rejectedTopics = %v", merged.RejectedTopics)
	}
	if merged.Enabled == nil || !*merged.Enabled {
		t.Fatalf("enabled = %v", merged.Enabled)
	}
}

// The system_sync read-only guard tests field presence (NestJS: value !==
// undefined), so an explicit null still has to be rejected.
func TestUpdateNullStillTripsSystemSyncGuard(t *testing.T) {
	patch, err := validateUpdate([]byte(`{"name":null}`))
	if err != nil {
		t.Fatalf("validateUpdate = %v", err)
	}
	if !patch.rejectsSystemSync() {
		t.Fatal("null name was treated as absent")
	}

	// enabled and color are writable on the system sync monitor.
	for _, body := range []string{`{"enabled":null}`, `{"color":null}`} {
		patch, err := validateUpdate([]byte(body))
		if err != nil {
			t.Fatalf("validateUpdate(%s) = %v", body, err)
		}
		if patch.rejectsSystemSync() {
			t.Fatalf("%s was treated as read only", body)
		}
	}
}

// color/location null is the documented "clear" path, unlike the other fields.
func TestUpdateNullClearsColorAndLocation(t *testing.T) {
	patch, err := validateUpdate([]byte(`{"color":null,"location":null}`))
	if err != nil {
		t.Fatalf("validateUpdate = %v", err)
	}
	merged := mergePatch(monitorRow{
		Color:        sql.NullString{String: "#ff0000", Valid: true},
		LocationName: sql.NullString{String: "Kyiv", Valid: true},
		LocationLat:  sql.NullFloat64{Float64: 50.45, Valid: true},
		LocationLng:  sql.NullFloat64{Float64: 30.52, Valid: true},
	}, patch)
	if merged.Color != "" {
		t.Fatalf("color = %q", merged.Color)
	}
	if merged.Location != nil {
		t.Fatalf("location = %+v", merged.Location)
	}
}

// Create defaults approvedLexicalTerms from rawKeywords; an explicit null is the
// same as omitting the field in NestJS.
func TestCreateNullApprovedLexicalDefaultsToKeywords(t *testing.T) {
	write, err := validateCreate([]byte(`{"name":"A","rawKeywords":["k1"],"approvedLexicalTerms":null}`), false)
	if err != nil {
		t.Fatalf("validateCreate = %v", err)
	}
	if write.ApprovedLexical != nil {
		t.Fatalf("approvedLexical = %v", write.ApprovedLexical)
	}
	if len(write.RawKeywords) != 1 || write.RawKeywords[0] != "k1" {
		t.Fatalf("rawKeywords = %v", write.RawKeywords)
	}
}
