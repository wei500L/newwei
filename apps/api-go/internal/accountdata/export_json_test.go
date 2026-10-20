package accountdata

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

func testSmallSections() *smallSections {
	created := "2026-10-20T00:00:00.000Z"
	return &smallSections{
		account: &exportAccount{
			ID:            "user-1",
			Email:         "user@example.com",
			EmailVerified: &created,
			PendingEmail:  nil,
			FirstName:     "Ada",
			LastName:      "<Lovelace & Co>",
			AvatarURL:     nil,
			IsActive:      true,
			LastLoginAt:   &created,
			CreatedAt:     &created,
			UpdatedAt:     &created,
			TotpFactor:    nil,
			RecoveryCodes: []exportRecoveryCode{},
		},
		membership: &exportMembership{
			ID: "membership-1", UserID: "user-1", OrgID: "org-1", RoleID: "role-1",
			IsActive: true, CreatedAt: &created,
			Org: &exportMembershipOrg{
				ID: "org-1", Name: "Acme", Slug: "acme", IsActive: true,
				CreatedAt: &created, UpdatedAt: &created,
			},
			Role: &exportRole{
				ID: "role-1", Name: "owner", IsSystem: true,
				Permissions: []exportRolePermission{{Permission: exportPermission{Name: "settings.manage"}}},
			},
			Roles: []exportMembershipRole{},
		},
		userSettings: []exportUserSetting{{
			Key: "ui.theme", Value: json.RawMessage(`{"mode":"dark","labels":["<b>","&"]}`),
			CreatedAt: &created, UpdatedAt: &created,
		}},
		contentSubscriptions: []exportContentSubscription{{
			ID: "sub-1", Kind: "topic", NormalizedValue: "ai", DisplayValue: "AI",
			Source: "manual", Metadata: json.RawMessage(`null`), CreatedAt: &created, UpdatedAt: &created,
		}},
		newsBehavior: exportNewsBehavior{
			Profile: json.RawMessage(`{"actions":{},"positive":{},"meta":{"legacyFallbackUsed":false}}`),
			Aggregates: []exportBehaviorAggregate{{
				SignalType: "topic", SignalKey: "ai", Score: 0.5,
				LastInteractedAt: &created, CreatedAt: &created, UpdatedAt: &created,
			}},
			SimilaritySnapshot: nil,
		},
		digest: exportDigest{DeliverySchedule: nil},
	}
}

func TestStreamedExportMatchesOneShotBytes(t *testing.T) {
	identity := &accountsecurity.Identity{UserID: "user-1", OrgID: "org-1"}
	small := testSmallSections()
	created := "2026-10-20T00:00:00.000Z"
	saved := []exportSavedView{{
		ID: "view-1", Title: "<saved>", Surface: "search", RoutePath: "/search",
		QueryState: json.RawMessage(`{"q":"a&b"}`), Visibility: "private",
		CreatedAt: &created, UpdatedAt: &created,
	}}
	threads := []exportAnalysisThread{{
		ID: "thread-1", SubjectType: "item", SubjectID: "item-1",
		NoteMarkdown: stringPointer("note <&>"), CreatedAt: &created, UpdatedAt: &created,
	}}
	comments := []exportAnalysisComment{{
		ID: "comment-1", ThreadID: "thread-1", BodyMarkdown: "hello <world>",
		CreatedAt: &created, UpdatedAt: &created,
	}}
	notifications := []exportNotification{{
		ID: "notification-1", Type: "crawl_completed", Title: "done & dusted",
		Data: json.RawMessage(`{"ok":true,"html":"<b>&"}`), CreatedAt: &created, UpdatedAt: &created,
	}}
	runs := []AssistantRun{{
		ID: stringPointer("65f0c0ffee00000000000001"), OrgID: stringPointer("org-1"), Type: stringPointer("query"),
		Status: stringPointer("completed"), Input: json.RawMessage(`{"q":"<x>"}`),
		Summary: nil, Error: nil, Model: nil, TriggeredByID: stringPointer("user-1"),
		CreatedAt: &created, UpdatedAt: &created,
	}}
	streams := exportStreams{
		savedViews: func(_ context.Context, _, _ string, yield func(exportSavedView) error) error {
			return iterateSlice(saved, yield)
		},
		threads: func(_ context.Context, _, _ string, yield func(exportAnalysisThread) error) error {
			return iterateSlice(threads, yield)
		},
		comments: func(_ context.Context, _, _ string, yield func(exportAnalysisComment) error) error {
			return iterateSlice(comments, yield)
		},
		notifications: func(_ context.Context, _, _ string, yield func(exportNotification) error) error {
			return iterateSlice(notifications, yield)
		},
		assistantRuns: func(_ context.Context, _, _ string, yield func(AssistantRun) error) error {
			return iterateSlice(runs, yield)
		},
	}

	var streamed bytes.Buffer
	buffered := bufio.NewWriter(&streamed)
	stream := &jsonStream{writer: buffered}
	counts, err := (&Service{}).writeExportBody(stream, context.Background(), identity, created, small, streams)
	if err == nil {
		err = stream.err
	}
	if err == nil {
		err = buffered.Flush()
	}
	if err != nil {
		t.Fatalf("writeExportBody: %v", err)
	}

	payload := exportPayload{
		Format:     exportFormat,
		Version:    exportVersion,
		ExportedAt: created,
		Subject:    exportSubject{UserID: identity.UserID, OrgID: identity.OrgID},
		Sections: exportSections{
			Account:              small.account,
			Membership:           small.membership,
			UserSettings:         small.userSettings,
			ContentSubscriptions: small.contentSubscriptions,
			NewsBehavior:         small.newsBehavior,
			Digest:               small.digest,
			AnalysisWorkspace: exportAnalysisWorkspace{
				SavedViews: saved,
				Threads:    threads,
				Comments:   comments,
			},
			Notifications: notifications,
			AssistantRuns: runs,
		},
	}
	var oneShot bytes.Buffer
	encoder := json.NewEncoder(&oneShot)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(payload); err != nil {
		t.Fatalf("reference encode: %v", err)
	}

	if !bytes.Equal(streamed.Bytes(), oneShot.Bytes()) {
		t.Fatalf("streamed output differs from one-shot output\n--- streamed ---\n%s\n--- one-shot ---\n%s", streamed.String(), oneShot.String())
	}
	if !bytes.Contains(streamed.Bytes(), []byte("<Lovelace & Co>")) {
		t.Fatal("streamed output HTML-escaped a scalar")
	}
	if bytes.Contains(streamed.Bytes(), []byte(`\u003c`)) {
		t.Fatal("streamed output HTML-escaped with an escape sequence")
	}
	wantCounts := recordCount{
		UserSettings: 1, ContentSubscriptions: 1, NewsBehaviorAggregates: 1,
		SavedViews: 1, AnalysisThreads: 1, AnalysisComments: 1,
		Notifications: 1, AssistantRuns: 1,
	}
	if counts != wantCounts {
		t.Fatalf("counts = %+v, want %+v", counts, wantCounts)
	}
}

func stringPointer(value string) *string { return &value }

func iterateSlice[T any](values []T, yield func(T) error) error {
	for _, value := range values {
		if err := yield(value); err != nil {
			return err
		}
	}
	return nil
}

func TestResolveOrgSlugSanitizes(t *testing.T) {
	cases := []struct {
		membership *exportMembership
		want       string
	}{
		{membership: nil, want: "org"},
		{membership: &exportMembership{}, want: "org"},
		{membership: &exportMembership{Org: &exportMembershipOrg{Slug: "Acme Corp!"}}, want: "Acme-Corp"},
		{membership: &exportMembership{Org: &exportMembershipOrg{Slug: "  --  "}}, want: "org"},
		{membership: &exportMembership{Org: &exportMembershipOrg{Slug: strings.Repeat("a", 70)}}, want: strings.Repeat("a", 64)},
	}
	for _, tc := range cases {
		if got := resolveOrgSlug(tc.membership); got != tc.want {
			t.Errorf("resolveOrgSlug = %q, want %q", got, tc.want)
		}
	}
}
