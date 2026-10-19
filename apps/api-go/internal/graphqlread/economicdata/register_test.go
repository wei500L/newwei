package economicdata

import (
	"testing"

	econdata "github.com/wei500L/newwei/apps/api-go/internal/economicdata"
)

func TestMutationFailureStatuses(t *testing.T) {
	preset := mutationFailure(&econdata.PresetError{Message: "empty"})
	if preset.Status != 400 || preset.Message != "empty" {
		t.Fatalf("preset failure = %+v", preset)
	}
	limit := mutationFailure(&econdata.RateLimitError{Message: "later"})
	if limit.Status != 429 || limit.Message != "later" {
		t.Fatalf("limit failure = %+v", limit)
	}
	missing := mutationFailure(&econdata.ItemNotFoundError{Slug: "x"})
	if missing.Status != 500 || missing.Message != "Data item x not found" || !missing.ExposeMessage {
		t.Fatalf("item failure = %+v", missing)
	}
}
