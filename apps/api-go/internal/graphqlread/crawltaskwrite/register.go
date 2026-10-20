// Package crawltaskwrite registers the three crawl task GraphQL mutations
// (createCrawlTask, deleteCrawlTask, retryCrawlTask) on top of the shared
// crawltaskwrite domain service.
//
// It registers no object type: the CrawlTaskModel graph must be registered
// exactly once by the caller (settingscrawl.Register when the settings/crawl
// read switch is go, otherwise settingscrawl.RegisterCrawlTaskModelTypes).
package crawltaskwrite

import (
	"context"
	"errors"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	crawltask "github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// permissionCrawlWrite is the @HasPermission("crawl.write") decorator value.
const permissionCrawlWrite = "crawl.write"

// Register adds the three mutations. The caller must have registered the
// CrawlTaskModel object graph already.
func Register(reg *contract.Registry, svc *crawltask.Service) {
	if reg == nil {
		panic("graphqlread: crawltaskwrite.Register requires a registry")
	}
	reg.RegisterMutation(contract.Root{
		Name:       "createCrawlTask",
		Permission: permissionCrawlWrite,
		Resolve:    contract.Bind(createCrawlTask(svc)),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "deleteCrawlTask",
		Permission: permissionCrawlWrite,
		Resolve:    contract.Bind(deleteCrawlTask(svc)),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "retryCrawlTask",
		Permission: permissionCrawlWrite,
		Resolve:    contract.Bind(retryCrawlTask(svc)),
	})
}

// RegisteredMutations lists the mutation names Register adds. The startup log
// uses it.
var RegisteredMutations = []string{"createCrawlTask", "deleteCrawlTask", "retryCrawlTask"}

func createCrawlTask(svc *crawltask.Service) func(contract.Context) (settingscrawl.CrawlTaskModel, error) {
	return func(ctx contract.Context) (settingscrawl.CrawlTaskModel, error) {
		if svc == nil {
			return settingscrawl.CrawlTaskModel{}, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
		}
		input, err := createInputFromGraphQL(ctx.Args)
		if err != nil {
			return settingscrawl.CrawlTaskModel{}, graphqlFailure(err)
		}
		view, err := svc.CreateTask(callContext(ctx), identityOf(ctx), input, nil)
		if err != nil {
			return settingscrawl.CrawlTaskModel{}, graphqlFailure(err)
		}
		return settingscrawl.CrawlTaskModelFromView(view), nil
	}
}

func deleteCrawlTask(svc *crawltask.Service) func(contract.Context) (bool, error) {
	return func(ctx contract.Context) (bool, error) {
		if svc == nil {
			return false, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
		}
		taskID, _ := ctx.Args["id"].(string)
		if err := svc.DeleteTask(callContext(ctx), identityOf(ctx), taskID); err != nil {
			return false, graphqlFailure(err)
		}
		return true, nil
	}
}

func retryCrawlTask(svc *crawltask.Service) func(contract.Context) (settingscrawl.CrawlTaskModel, error) {
	return func(ctx contract.Context) (settingscrawl.CrawlTaskModel, error) {
		if svc == nil {
			return settingscrawl.CrawlTaskModel{}, &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
		}
		taskID, _ := ctx.Args["id"].(string)
		view, err := svc.RetryTask(callContext(ctx), identityOf(ctx), taskID, nil)
		if err != nil {
			return settingscrawl.CrawlTaskModel{}, graphqlFailure(err)
		}
		return settingscrawl.CrawlTaskModelFromView(view), nil
	}
}

// identityOf converts the contract identity into the shared authenticator
// identity type. Permissions stay the MySQL-derived set.
func identityOf(ctx contract.Context) *authhttp.Identity {
	permissions := make([]string, 0, len(ctx.Identity.Permissions))
	for name, granted := range ctx.Identity.Permissions {
		if granted {
			permissions = append(permissions, name)
		}
	}
	return authhttp.NewIdentity(ctx.Identity.UserID, ctx.Identity.OrgID, permissions)
}

func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

// graphqlFailure maps a domain error onto the GraphQL field failure shape.
func graphqlFailure(err error) error {
	if err == nil {
		return nil
	}
	var input *inputFailure
	if errors.As(err, &input) {
		return &contract.Failure{Message: input.Error(), Status: http.StatusBadRequest}
	}
	var policy *crawloptions.PolicyError
	if errors.As(err, &policy) {
		return &contract.Failure{Message: policy.Message, Status: http.StatusBadRequest}
	}
	var failure *contract.Failure
	if errors.As(err, &failure) {
		return failure
	}
	if status, message, ok := crawltask.HTTPStatus(err); ok {
		return &contract.Failure{Message: message, Status: status}
	}
	return err
}
