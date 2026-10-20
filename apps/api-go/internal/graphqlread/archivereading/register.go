package archivereading

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	domain "github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

const readPermission = "items.read"

// Register adds the three archive query roots and their SDL models.
func Register(reg *contract.Registry, service *domain.Service) {
	if reg == nil {
		panic("graphqlread: archivereading.Register requires a registry")
	}
	reg.RegisterType("ArchivePreparationStatusModel", ArchivePreparationStatusModel{})
	reg.RegisterType("ArchiveEventItemModel", ArchiveEventItemModel{})
	reg.RegisterType("ArchiveVerticalPageInfoModel", ArchiveVerticalPageInfoModel{})
	reg.RegisterType("ArchiveVerticalGroupModel", ArchiveVerticalGroupModel{})
	reg.RegisterType("ArchiveDigestModel", ArchiveDigestModel{})
	reg.RegisterType("ArchiveCalendarDayModel", ArchiveCalendarDayModel{})
	reg.RegisterType("ArchiveTimelineEntryModel", ArchiveTimelineEntryModel{})
	reg.RegisterType("ArchiveRelatedArticleModel", ArchiveRelatedArticleModel{})
	reg.RegisterType("ArchiveClassificationScoreEntryModel", ArchiveClassificationScoreEntryModel{})
	reg.RegisterType("ArchiveClassificationDetailModel", ArchiveClassificationDetailModel{})
	reg.RegisterType("ArchiveDetailModel", ArchiveDetailModel{})

	resolver := &resolver{service: service}
	reg.RegisterRoot(contract.Root{Name: "archiveDigest", Permission: readPermission, Resolve: contract.Bind(resolver.digest)})
	reg.RegisterRoot(contract.Root{Name: "archiveCalendar", Permission: readPermission, Resolve: contract.Bind(resolver.calendar)})
	reg.RegisterRoot(contract.Root{Name: "archiveDetail", Permission: readPermission, Resolve: contract.Bind(resolver.detail)})
}

type resolver struct {
	service *domain.Service
}

func (r *resolver) digest(ctx contract.Context) (ArchiveDigestModel, error) {
	orgID, err := requireOrgID(ctx)
	if err != nil {
		return ArchiveDigestModel{}, err
	}
	input, err := decodeDigestInput(ctx)
	if err != nil {
		return ArchiveDigestModel{}, err
	}
	result, err := r.service.Digest(ctx.Ctx, orgID, input)
	if err != nil {
		return ArchiveDigestModel{}, failure(err)
	}
	return convertDigest(result), nil
}

func (r *resolver) calendar(ctx contract.Context) ([]ArchiveCalendarDayModel, error) {
	orgID, err := requireOrgID(ctx)
	if err != nil {
		return nil, err
	}
	input, err := decodeCalendarInput(ctx)
	if err != nil {
		return nil, err
	}
	days, err := r.service.Calendar(ctx.Ctx, orgID, input)
	if err != nil {
		return nil, failure(err)
	}
	out := make([]ArchiveCalendarDayModel, 0, len(days))
	for _, day := range days {
		out = append(out, ArchiveCalendarDayModel{Date: day.Date, Count: day.Count})
	}
	return out, nil
}

func (r *resolver) detail(ctx contract.Context) (*ArchiveDetailModel, error) {
	orgID, err := requireOrgID(ctx)
	if err != nil {
		return nil, err
	}
	processedArticleID, ok := contract.StringArg(ctx.Args, "processedArticleId")
	if !ok {
		return nil, badRequest()
	}
	result, err := r.service.Detail(ctx.Ctx, orgID, processedArticleID)
	if err != nil {
		return nil, failure(err)
	}
	if result == nil {
		return nil, nil
	}
	model := convertDetail(*result)
	return &model, nil
}

func requireOrgID(ctx contract.Context) (string, error) {
	orgID := strings.TrimSpace(ctx.Identity.OrgID)
	if orgID == "" {
		return "", &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized}
	}
	return orgID, nil
}

// decodeDigestInput validates the DTO bounds the SDL does not carry. An invalid
// value is a 400, never a silent service default.
func decodeDigestInput(ctx contract.Context) (domain.DigestInput, error) {
	record, ok := contract.MapArg(ctx.Args, "input")
	if !ok {
		return domain.DigestInput{}, badRequest()
	}
	anchorRaw, ok := stringMember(record, "anchorDate")
	if !ok {
		return domain.DigestInput{}, badRequest()
	}
	anchor, ok := parseDateTime(anchorRaw)
	if !ok {
		return domain.DigestInput{}, badRequest()
	}
	regionRaw, ok := stringMember(record, "region")
	if !ok {
		return domain.DigestInput{}, badRequest()
	}
	region, ok := domain.ParseRegion(regionRaw)
	if !ok {
		return domain.DigestInput{}, badRequest()
	}

	input := domain.DigestInput{AnchorDate: anchor, Region: region, PageSize: 0}
	if search, ok := optionalStringMember(record, "search"); ok {
		if utf16Length(search) > 200 {
			return domain.DigestInput{}, badRequest()
		}
		input.Search = search
	}
	if weights, ok := listMember(record, "weights"); ok {
		if len(weights) > 5 {
			return domain.DigestInput{}, badRequest()
		}
		for _, value := range weights {
			text, ok := value.(string)
			if !ok {
				return domain.DigestInput{}, badRequest()
			}
			switch domain.Weight(text) {
			case domain.WeightOne, domain.WeightTwo, domain.WeightThree, domain.WeightFour, domain.WeightFive:
				input.Weights = append(input.Weights, domain.Weight(text))
			default:
				return domain.DigestInput{}, badRequest()
			}
		}
	}
	if pageSize, ok := optionalIntMember(record, "pageSize"); ok {
		if pageSize < 1 || pageSize > 100 {
			return domain.DigestInput{}, badRequest()
		}
		input.PageSize = pageSize
	} else if limit, ok := optionalIntMember(record, "limitPerVertical"); ok {
		if limit < 1 || limit > 100 {
			return domain.DigestInput{}, badRequest()
		}
		input.PageSize = limit
	}
	if cursors, ok := listMember(record, "cursors"); ok {
		if len(cursors) > 5 {
			return domain.DigestInput{}, badRequest()
		}
		for _, raw := range cursors {
			entry, ok := raw.(map[string]any)
			if !ok {
				return domain.DigestInput{}, badRequest()
			}
			verticalRaw, ok := stringMember(entry, "vertical")
			if !ok {
				return domain.DigestInput{}, badRequest()
			}
			vertical, ok := domain.ParseVertical(verticalRaw)
			if !ok {
				return domain.DigestInput{}, badRequest()
			}
			cursorInput := domain.CursorInput{Vertical: vertical}
			if cursor, ok := optionalStringMember(entry, "cursor"); ok {
				if utf16Length(cursor) > 256 {
					return domain.DigestInput{}, badRequest()
				}
				cursorInput.Cursor = &cursor
			}
			input.Cursors = append(input.Cursors, cursorInput)
		}
	}
	return input, nil
}

func decodeCalendarInput(ctx contract.Context) (domain.CalendarInput, error) {
	record, ok := contract.MapArg(ctx.Args, "input")
	if !ok {
		return domain.CalendarInput{}, badRequest()
	}
	month, ok := stringMember(record, "month")
	if !ok || !monthDTOPattern(month) {
		return domain.CalendarInput{}, &contract.Failure{
			Message: "archiveCalendar month must be in YYYY-MM format.",
			Status:  http.StatusBadRequest,
			AppCode: domain.AppCodeMonthInvalid,
		}
	}
	input := domain.CalendarInput{Month: month}
	if regionRaw, ok := optionalStringMember(record, "region"); ok {
		region, ok := domain.ParseRegion(regionRaw)
		if !ok {
			return domain.CalendarInput{}, badRequest()
		}
		input.Region = &region
	}
	if verticalRaw, ok := optionalStringMember(record, "vertical"); ok {
		vertical, ok := domain.ParseVertical(verticalRaw)
		if !ok {
			return domain.CalendarInput{}, badRequest()
		}
		input.Vertical = &vertical
	}
	return input, nil
}

func monthDTOPattern(month string) bool {
	if len(month) != 7 || month[4] != '-' {
		return false
	}
	for index, r := range month {
		if index == 4 {
			continue
		}
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseDateTime(value string) (time.Time, bool) {
	if parsed, ok := itemsreading.ParseTimeValue(strings.TrimSpace(value)); ok {
		return parsed, true
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	return parsed, err == nil
}

func stringMember(record map[string]any, name string) (string, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

func optionalStringMember(record map[string]any, name string) (string, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return "", false
	}
	if value == nil {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	return text, true
}

func optionalIntMember(record map[string]any, name string) (int, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue || value == nil {
		return 0, false
	}
	number, ok := contract.AsInt(value)
	return number, ok
}

func listMember(record map[string]any, name string) ([]any, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue || value == nil {
		return nil, false
	}
	list, ok := value.([]any)
	if !ok {
		// The executor passes JSON-decoded slices; a typed slice is accepted
		// through the generic JSON round-trip at the boundary.
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, false
		}
	}
	return list, true
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func badRequest() error {
	return &contract.Failure{Message: "Bad Request", Status: http.StatusBadRequest}
}

func failure(err error) error {
	var archiveError *domain.Error
	if errors.As(err, &archiveError) {
		return &contract.Failure{
			Message: archiveError.Message,
			Status:  archiveError.Status,
			AppCode: archiveError.AppCode,
		}
	}
	log.Printf("api-go: archive reading graphql failure: %v", err)
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}
