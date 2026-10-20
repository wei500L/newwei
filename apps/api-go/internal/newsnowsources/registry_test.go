package newsnowsources

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

// TestRegistryCoverage pins the 64-id contract: every non-redirect registry id
// has a getter, every getter belongs to a non-redirect registry id, and the
// redirect parents stay alias-only.
func TestRegistryCoverage(t *testing.T) {
	ids := newsnowclusteringops.KnownSourceIDs()
	if len(ids) != 64 {
		t.Fatalf("registry ids=%d, want 64", len(ids))
	}
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())

	nonRedirect := make(map[string]struct{})
	for _, id := range ids {
		meta, ok := newsnowclusteringops.LookupSourceMetadata(id)
		if !ok {
			t.Fatalf("metadata missing for %s", id)
		}
		if meta.Redirect != "" {
			if _, exists := service.getters[id]; exists {
				t.Fatalf("redirect parent %s must not have its own getter", id)
			}
			continue
		}
		nonRedirect[id] = struct{}{}
		if _, exists := service.getters[id]; !exists {
			t.Fatalf("no getter for reachable id %s", id)
		}
	}

	for id := range service.getters {
		if _, ok := nonRedirect[id]; !ok {
			t.Fatalf("getter %s is not a reachable registry id", id)
		}
	}
}
