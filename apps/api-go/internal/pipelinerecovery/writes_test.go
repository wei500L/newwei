package pipelinerecovery

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// TestParseObjectIDMatchesMongoose pins Types.ObjectId.isValid for strings: 24
// hex characters, or exactly 12 bytes used as the raw ObjectId bytes.
func TestParseObjectIDMatchesMongoose(t *testing.T) {
	cases := []struct {
		name  string
		value string
		ok    bool
	}{
		{"24 hex", "507f1f77bcf86cd799439011", true},
		{"24 hex uppercase", "507F1F77BCF86CD799439011", true},
		{"24 non-hex", "507f1f77bcf86cd79943901z", false},
		{"12 bytes", "abcdefghijkl", true},
		{"11 bytes", "abcdefghijk", false},
		{"13 bytes", "abcdefghijklm", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, ok := parseObjectID(tc.value)
			if ok != tc.ok {
				t.Fatalf("parseObjectID(%q) ok = %t, want %t", tc.value, ok, tc.ok)
			}
			if !ok {
				return
			}
			if tc.value == "abcdefghijkl" && string(id[:]) != tc.value {
				t.Fatalf("12-byte id = %q", string(id[:]))
			}
			if len(tc.value) == 24 && id.Hex() != tc.value {
				t.Fatalf("hex round trip = %q", id.Hex())
			}
		})
	}
}

// TestRawBelongsToRequiresStringItemMetaID mirrors `raw.itemMetaId !==
// itemMetaId`: undefined or a non-string never matches.
func TestRawBelongsToRequiresStringItemMetaID(t *testing.T) {
	decode := func(document bson.D) storedRawItem {
		raw, err := bson.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		var stored storedRawItem
		if err := bson.Unmarshal(raw, &stored); err != nil {
			t.Fatal(err)
		}
		return stored
	}
	if !rawBelongsTo(decode(bson.D{{Key: "itemMetaId", Value: "item-1"}}), "item-1") {
		t.Fatal("matching itemMetaId must belong")
	}
	if rawBelongsTo(decode(bson.D{{Key: "itemMetaId", Value: "item-2"}}), "item-1") {
		t.Fatal("different itemMetaId must not belong")
	}
	if rawBelongsTo(decode(bson.D{{Key: "payload", Value: bson.D{}}}), "item-1") {
		t.Fatal("missing itemMetaId must not belong")
	}
	if rawBelongsTo(decode(bson.D{{Key: "itemMetaId", Value: 42}}), "item-1") {
		t.Fatal("non-string itemMetaId must not belong")
	}
}

// TestDecodeJSONBody pins the body shapes: JSON object, empty body, non-JSON
// content type and malformed JSON.
func TestDecodeJSONBody(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		body        string
		wantID      string
		wantErr     bool
	}{
		{"object", "application/json", `{"itemMetaId":"item-1","rawItemId":"raw-1"}`, "item-1", false},
		{"empty body", "application/json", ``, "", false},
		{"no content type", "", `{"itemMetaId":"item-1"}`, "item-1", false},
		{"non json content type ignored", "text/plain", `{"itemMetaId":"item-1"}`, "", false},
		{"malformed", "application/json", `{`, "", true},
		{"array", "application/json", `[]`, "", true},
		{"wrong field type", "application/json", `{"itemMetaId":42}`, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", replayPath, bytes.NewBufferString(tc.body))
			if tc.contentType != "" {
				request.Header.Set("Content-Type", tc.contentType)
			}
			var body pipelineWriteBody
			err := decodeJSONBody(request, &body)
			if tc.wantErr {
				status, _, ok := statusOf(err)
				if !ok || status != 400 {
					t.Fatalf("error = %v, want 400", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if got := stringValue(body.ItemMetaID); got != tc.wantID {
				t.Fatalf("itemMetaId = %q, want %q", got, tc.wantID)
			}
		})
	}
}

// TestReplayResultOmitsEmptyQueueJobID pins the optional queueJobId field: the
// NestJS response drops `queueJobId: undefined`.
func TestReplayResultOmitsEmptyQueueJobID(t *testing.T) {
	encoded, err := json.Marshal(ReplayResult{ItemMetaID: "item-1", RawItemID: "raw-1"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"itemMetaId":"item-1","rawItemId":"raw-1"}` {
		t.Fatalf("replay body = %s", encoded)
	}
	encoded, err = json.Marshal(RollbackResult{ItemMetaID: "item-1", RawItemID: "raw-1", ProcessedItemID: "pid-1"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"itemMetaId":"item-1","rawItemId":"raw-1","processedItemId":"pid-1"}` {
		t.Fatalf("rollback body = %s", encoded)
	}
}
