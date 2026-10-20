package itemsingestgraphql

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	itemsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// identityInfo is the server-derived caller. Auth middleware guarantees both
// ids; the checks keep the mutation safe if it is ever invoked by a test.
func identityInfo(ctx contract.Context) (string, string, map[string]bool, error) {
	orgID := strings.TrimSpace(ctx.Identity.OrgID)
	userID := strings.TrimSpace(ctx.Identity.UserID)
	if orgID == "" || userID == "" {
		return "", "", nil, &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized}
	}
	return orgID, userID, ctx.Identity.Permissions, nil
}

// requirePermission is the single-permission ANY shape.
func requirePermission(held map[string]bool, permission string) error {
	if held[permission] {
		return nil
	}
	return &itemsingest.Failure{
		Status:              http.StatusForbidden,
		Message:             "Insufficient permissions",
		Code:                "INSUFFICIENT_PERMISSIONS",
		Detail:              "Requires any permission: " + permission,
		RequiredPermissions: []string{permission},
		PermissionsMode:     "any",
	}
}

// requireAll is the @PermissionsAll shape.
func requireAll(held map[string]bool, required ...string) error {
	return itemsingest.RequireAllPermissions(held, required...)
}

// mapError converts a typed service failure into the GraphQL executor failure
// contract. Untyped errors stay internal and are masked by the executor.
func mapError(err error) error {
	if err == nil {
		return nil
	}
	failure := itemsingest.AsFailure(err)
	if failure == nil {
		return err
	}
	status := failure.Status
	if status == 0 {
		status = http.StatusInternalServerError
	}
	return &contract.Failure{
		Message:             failure.Message,
		Status:              status,
		AppCode:             failure.Code,
		Detail:              failure.Detail,
		RequiredPermissions: failure.RequiredPermissions,
		PermissionsMode:     failure.PermissionsMode,
		MissingPermissions:  failure.MissingPermissions,
	}
}

func (r *resolver) createItem(ctx contract.Context) (*itemsgraphql.ItemModel, error) {
	orgID, userID, permissions, err := identityInfo(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermission(permissions, itemsingest.WritePermission); err != nil {
		return nil, mapError(err)
	}
	input, err := parseCreateItemInput(ctx.Args)
	if err != nil {
		return nil, mapError(err)
	}
	// GraphQL create parses the payload before the service decides whether an
	// existing externalId makes the payload irrelevant.
	payload, err := itemsingest.DecodePayloadString(input.Payload)
	if err != nil {
		return nil, mapError(err)
	}
	result, err := r.svc.Create(ctx.Ctx, orgID, userID, itemsingest.CreateItemInput{
		ExternalID: input.ExternalID,
		Name:       input.Title,
		Status:     input.Status,
		Payload:    payload,
	})
	if err != nil {
		return nil, mapError(err)
	}
	return r.buildItem(ctx, orgID, result.Meta)
}

func (r *resolver) updateItem(ctx contract.Context) (*itemsgraphql.ItemModel, error) {
	orgID, userID, permissions, err := identityInfo(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermission(permissions, itemsingest.WritePermission); err != nil {
		return nil, mapError(err)
	}
	input, err := parseUpdateItemInput(ctx.Args)
	if err != nil {
		return nil, mapError(err)
	}
	var payload []byte
	if input.Payload != nil && *input.Payload != "" {
		payload, err = itemsingest.DecodePayloadString(*input.Payload)
		if err != nil {
			return nil, mapError(err)
		}
	}
	updated, err := r.svc.Update(ctx.Ctx, orgID, userID, itemsingest.UpdateItemInput{
		ID:      input.ID,
		Name:    input.Title,
		Status:  input.Status,
		Payload: payload,
	})
	if err != nil {
		return nil, mapError(err)
	}
	return r.buildItem(ctx, orgID, updated)
}

func (r *resolver) createItemFromCrawlResult(ctx contract.Context) (*itemsgraphql.ItemModel, error) {
	orgID, userID, permissions, err := identityInfo(ctx)
	if err != nil {
		return nil, err
	}
	if err := requireAll(permissions, itemsingest.CrawlRead, itemsingest.WritePermission); err != nil {
		return nil, mapError(err)
	}
	resultID, ok := contract.StringArg(ctx.Args, "resultId")
	if !ok {
		return nil, mapError(itemsingest.NewFailure(http.StatusBadRequest, "resultId is required"))
	}
	normalized := strings.TrimSpace(resultID)
	if normalized == "" {
		return nil, mapError(itemsingest.NewFailure(http.StatusBadRequest, "resultId is required"))
	}
	meta, err := r.svc.CreateFromCrawlResult(ctx.Ctx, orgID, userID, normalized)
	if err != nil {
		return nil, mapError(err)
	}
	return r.buildItem(ctx, orgID, meta)
}

func (r *resolver) ingestCrawlTaskResultsToItems(ctx contract.Context) (CrawlIngestBatchModel, error) {
	orgID, userID, permissions, err := identityInfo(ctx)
	if err != nil {
		return CrawlIngestBatchModel{}, err
	}
	if err := requireAll(permissions, itemsingest.CrawlRead, itemsingest.WritePermission); err != nil {
		return CrawlIngestBatchModel{}, mapError(err)
	}
	taskID, ok := contract.StringArg(ctx.Args, "taskId")
	if !ok {
		return CrawlIngestBatchModel{}, mapError(itemsingest.NewFailure(http.StatusBadRequest, "taskId must be a string"))
	}
	options := itemsingest.IngestBatchOptions{}
	if value, state := contract.Lookup(ctx.Args, "after"); state == contract.ArgValue {
		if text, ok := value.(string); ok {
			options.After = &text
		}
	}
	if value, state := contract.Lookup(ctx.Args, "limit"); state == contract.ArgValue {
		if number, ok := value.(float64); ok {
			options.Limit = &number
		}
	}
	if value, state := contract.Lookup(ctx.Args, "onlyMissing"); state == contract.ArgValue {
		if flag, ok := value.(bool); ok {
			options.OnlyMissing = &flag
		}
	}
	summary, err := r.svc.IngestCrawlTaskResults(ctx.Ctx, orgID, userID, taskID, options)
	if err != nil {
		return CrawlIngestBatchModel{}, mapError(err)
	}
	return CrawlIngestBatchModel{
		TaskID:          summary.TaskID,
		Scanned:         summary.Scanned,
		Attempted:       summary.Attempted,
		Ingested:        summary.Ingested,
		SkippedExisting: summary.SkippedExisting,
		Failed:          summary.Failed,
		NextCursor:      summary.NextCursor,
		HasMore:         summary.HasMore,
	}, nil
}

func (r *resolver) updateCrawlTaskIngestToItems(ctx contract.Context) (settingscrawl.CrawlTaskModel, error) {
	orgID, userID, permissions, err := identityInfo(ctx)
	if err != nil {
		return settingscrawl.CrawlTaskModel{}, err
	}
	// crawl.write gates the root; items.write is checked by the service after
	// the task exists and before the no-op comparison.
	if err := requirePermission(permissions, itemsingest.CrawlWrite); err != nil {
		return settingscrawl.CrawlTaskModel{}, mapError(err)
	}
	id, ok := contract.StringArg(ctx.Args, "id")
	if !ok {
		return settingscrawl.CrawlTaskModel{}, mapError(itemsingest.NewFailure(http.StatusBadRequest, "id must be a string"))
	}
	enabled := false
	if value, state := contract.Lookup(ctx.Args, "enabled"); state == contract.ArgValue {
		if flag, ok := value.(bool); ok {
			enabled = flag
		}
	}
	view, err := r.svc.UpdateCrawlTaskIngest(ctx.Ctx, orgID, userID, permissions, id, enabled)
	if err != nil {
		return settingscrawl.CrawlTaskModel{}, mapError(err)
	}
	return settingscrawl.CrawlTaskModelFromView(*view), nil
}

// buildItem reuses the selection-driven read projection for the mutation
// response. Field-level items.read guards are registered on ItemModel, so a
// write-only caller selecting meta/raw/processed gets the same FORBIDDEN error
// as the read roots.
func (r *resolver) buildItem(ctx contract.Context, orgID string, row itemsdomain.ItemMetaRow) (*itemsgraphql.ItemModel, error) {
	if r == nil || r.items == nil {
		return nil, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
	}
	models, err := itemsgraphql.BuildItemModels(ctx, r.items, orgID, []itemsdomain.ItemMetaRow{row})
	if err != nil {
		return nil, mapError(err)
	}
	model, ok := models[row.ID]
	if !ok {
		return nil, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
	}
	return model, nil
}
