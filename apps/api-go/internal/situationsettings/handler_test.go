package situationsettings

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

type fakeExternal struct {
	summary gdeltsnapshot.Summary
	err     error
}

func (f fakeExternal) GetStatusSummary(context.Context) (gdeltsnapshot.Summary, error) {
	return f.summary, f.err
}

type fakeQuality struct {
	summary *situationsignals.QualitySummary
	err     error
}

func (f fakeQuality) GetQualitySummary(context.Context, string) (*situationsignals.QualitySummary, error) {
	return f.summary, f.err
}

type fakeTelegram struct {
	calls   int
	enabled bool
	every   int
	err     error
}

func (f *fakeTelegram) Sync(_ context.Context, enabled bool, intervalMS int) error {
	f.calls++
	f.enabled = enabled
	f.every = intervalMS
	return f.err
}

type fakeEconomic struct {
	calls int
	err   error
}

func (f *fakeEconomic) EnsureRepeatableJobs(context.Context) error {
	f.calls++
	return f.err
}

func TestWriteWithExtrasIncludesNullQualitySummary(t *testing.T) {
	handler := &Handler{
		external: fakeExternal{summary: gdeltsnapshot.Summary{Status: "idle", Warnings: []gdeltsnapshot.Warning{}}},
		quality:  fakeQuality{err: errors.New("mongo down")},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, settingsPath, nil)
	handler.writeWithExtras(recorder, request, "org-1", PublicSettings{Source: SettingsSourceDB})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"qualitySummary":null`) {
		t.Fatalf("quality failure must be null: %s", body)
	}
	if !strings.Contains(body, `"externalSnapshotStatus":`) {
		t.Fatalf("missing external status: %s", body)
	}
	if !strings.Contains(body, `"source":"db"`) {
		t.Fatalf("missing public settings: %s", body)
	}
}

func TestWriteWithExtrasOmitsUndefinedTelegramApiID(t *testing.T) {
	handler := &Handler{
		external: fakeExternal{summary: gdeltsnapshot.Summary{Status: "idle", Warnings: []gdeltsnapshot.Warning{}}},
		quality:  fakeQuality{},
	}
	recorder := httptest.NewRecorder()
	handler.writeWithExtras(recorder, httptest.NewRequest(http.MethodGet, settingsPath, nil), "org", PublicSettings{})
	if strings.Contains(recorder.Body.String(), `"telegramApiId":`) {
		t.Fatalf("undefined telegramApiId must be omitted: %s", recorder.Body.String())
	}
}

func TestWriteWithExtrasExternalFailureIs500(t *testing.T) {
	handler := &Handler{
		external: fakeExternal{err: errors.New("snapshot read failed")},
		quality:  fakeQuality{},
	}
	recorder := httptest.NewRecorder()
	handler.writeWithExtras(recorder, httptest.NewRequest(http.MethodGet, settingsPath, nil), "org", PublicSettings{})
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Internal server error" {
		t.Fatalf("body = %v", body)
	}
}

func TestWriteWithExtrasMissingExternalProviderIs500(t *testing.T) {
	handler := &Handler{quality: fakeQuality{}}
	recorder := httptest.NewRecorder()
	handler.writeWithExtras(recorder, httptest.NewRequest(http.MethodGet, settingsPath, nil), "org", PublicSettings{})
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", recorder.Code)
	}
}

// TestSyncSchedulesAlwaysCallsBoth proves the two hot syncs run even when the
// settings did not change, and that their failures are swallowed.
func TestSyncSchedulesAlwaysCallsBoth(t *testing.T) {
	telegram := &fakeTelegram{err: errors.New("redis down")}
	economic := &fakeEconomic{err: errors.New("mysql down")}
	handler := &Handler{telegram: telegram, economic: economic}
	handler.syncSchedules(context.Background(), PublicSettings{TelegramEnabled: true, TelegramPollIntervalMS: 30_000})
	if telegram.calls != 1 || economic.calls != 1 {
		t.Fatalf("calls = %d/%d", telegram.calls, economic.calls)
	}
	if !telegram.enabled || telegram.every != 30_000 {
		t.Fatalf("telegram args = %+v", telegram)
	}
}

func TestServeHTTPRejectsUnlistedRoutes(t *testing.T) {
	handler := &Handler{auth: &platformgovernance.Authenticator{}, service: &Service{}}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, settingsPath, nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}
