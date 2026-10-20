package itemsreading

import (
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// RegisterWriteModelTypes records only the ItemModel object graph and the five
// field-level items.read guards. The write mutations return ItemModel while
// their roots only require items.write, so the nested meta/raw/processed/
// preview fields must not leak readable content without items.read.
//
// It registers no query root and reuses the exact projection used by the read
// roots, so a write response cannot drift from a read response.
func RegisterWriteModelTypes(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: itemsreading.RegisterWriteModelTypes requires a registry")
	}
	reg.RegisterType("ItemModel", ItemModel{})
	reg.RegisterType("ItemMetaModel", ItemMetaModel{})
	reg.RegisterType("RawItemModelGraph", RawItemModelGraph{})
	reg.RegisterType("RawItemPreviewModelGraph", RawItemPreviewModelGraph{})
	reg.RegisterType("ProcessedItemPreviewModelGraph", ProcessedItemPreviewModelGraph{})
	reg.RegisterType("ItemSearchHighlightModel", ItemSearchHighlightModel{})
	reg.RegisterType("SeriesPointModel", SeriesPointModel{})
	reg.RegisterType("ProcessedItemErrorModelGraph", workspace.ProcessedItemErrorModelGraph{})
	reg.RegisterType("ProcessedItemLlmModel", workspace.ProcessedItemLlmModel{})
	reg.RegisterType("ProcessedItemModelGraph", workspace.ProcessedItemModelGraph{})
	registerItemFieldPermissions(reg)
}

// registerItemFieldPermissions adds the five @HasPermission("items.read")
// fields. It tolerates an already-registered guard so read and write
// registrations can coexist in one process.
func registerItemFieldPermissions(reg *contract.Registry) {
	for _, field := range []string{"meta", "raw", "processed", "rawPreview", "processedPreview"} {
		if _, exists := reg.FieldPermission("ItemModel", field); exists {
			continue
		}
		reg.RegisterFieldPermission("ItemModel", field, itemsdomain.ReadPermission)
	}
}

// BuildItemModels reuses the read-side selection projection for a write
// response. The caller passes the mutation root's resolved selection so an
// id-only selection still avoids raw/processed reads.
func BuildItemModels(
	ctx contract.Context,
	svc *itemsdomain.Service,
	orgID string,
	rows []itemsdomain.ItemMetaRow,
) (map[string]*ItemModel, error) {
	instance := &resolver{svc: svc}
	return instance.buildItemModels(ctx, orgID, rows, itemNeedsFromSelection(ctx.Selection))
}
