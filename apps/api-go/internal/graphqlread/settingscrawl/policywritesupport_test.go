package settingscrawl

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestRegisterSourcePolicyModelTypesIncludesNestedModels guards the narrow
// registration surface: every nested object the four mutations project must be
// present, while the read-only crawl/Mongo models stay out.
func TestRegisterSourcePolicyModelTypesIncludesNestedModels(t *testing.T) {
	reg := contract.NewRegistry()
	RegisterSourcePolicyModelTypes(reg)
	for _, name := range []string{
		"NewsEventSourcePolicyDeltaModel",
		"NewsEventSourcePolicyConflictModel",
		"NewsEventSourceCategoryAuthorityDomainBoostModel",
		"NewsEventSourceCategoryAuthorityRuleModel",
		"NewsEventSourcePolicyRevisionModel",
		"NewsEventSourcePolicySettingsModel",
		"NewsEventSourcePolicyPresetSettingsModel",
	} {
		if !reg.HasType(name) {
			t.Fatalf("type %s is not registered", name)
		}
	}
	for _, name := range []string{"CrawlTaskModel", "KnowledgeGraphNodeModel"} {
		if reg.HasType(name) {
			t.Fatalf("read-only model %s leaked into the policy write surface", name)
		}
	}
}
