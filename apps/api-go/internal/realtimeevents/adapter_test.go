package realtimeevents

import (
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

// adapterFrame is the byte-level example of /tmp/spec-go-infra.md section 1.5:
// [uid, {type:2,data:["newsnow:update",{orgId:"org:abc",newItemsCount:2}],nsp:"/newsnow"},
//
//	{rooms:["org:abc"],except:[],flags:{}}]
const adapterFrameHex = "" +
	"93" + // fixarray(3)
	"a6414243444546" + // fixstr(6) "ABCDEF"
	"83" + // packet fixmap(3)
	"a474797065" + "02" + // "type": 2
	"a464617461" + "92" + // "data": array(2)
	"ae6e6577736e6f773a757064617465" + // "newsnow:update" (14 chars)
	"82" + // payload fixmap(2)
	"a56f72674964" + "a76f72673a616263" + // "orgId": "org:abc"
	"ad6e65774974656d73436f756e74" + "02" + // "newItemsCount": 2
	"a36e7370" + "a82f6e6577736e6f77" + // "nsp": "/newsnow"
	"83" + // opts fixmap(3)
	"a5726f6f6d73" + "91" + "a76f72673a616263" + // rooms: ["org:abc"]
	"a6657863657074" + "90" + // except: []
	"a5666c616773" + "80" // flags: {}

func adapterExampleBytes(t *testing.T) []byte {
	t.Helper()
	payload, err := hex.DecodeString(adapterFrameHex)
	if err != nil {
		t.Fatalf("decode adapter frame hex: %v", err)
	}
	return payload
}

func TestDecodeAdapterMessageByteExample(t *testing.T) {
	message, err := decodeAdapterMessage(adapterExampleBytes(t))
	if err != nil {
		t.Fatalf("decodeAdapterMessage() error = %v", err)
	}
	if message.UID != "ABCDEF" {
		t.Fatalf("uid = %q", message.UID)
	}
	if message.Namespace != "/newsnow" || message.Event != "newsnow:update" {
		t.Fatalf("namespace/event = %q/%q", message.Namespace, message.Event)
	}
	// Object key order must survive the msgpack -> JSON conversion.
	if got, want := string(message.PayloadJSON), `{"orgId":"org:abc","newItemsCount":2}`; got != want {
		t.Fatalf("payload = %s, want %s", got, want)
	}
	if len(message.Rooms) != 1 || message.Rooms[0] != "org:abc" {
		t.Fatalf("rooms = %#v", message.Rooms)
	}
	if len(message.Except) != 0 {
		t.Fatalf("except = %#v", message.Except)
	}
}

func TestDecodeAdapterMessageRejectsProtocolViolations(t *testing.T) {
	valid := adapterExampleBytes(t)
	cases := map[string][]byte{
		"truncated": valid[:len(valid)-1],
		"trailing":  append(append([]byte{}, valid...), 0x00),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeAdapterMessage(payload); err == nil {
				t.Fatal("decodeAdapterMessage() should fail")
			}
		})
	}
}

func TestEncodeAdapterBroadcastRoundTrip(t *testing.T) {
	type payloadExample struct {
		OrgID         string  `json:"orgId" msgpack:"orgId"`
		SourceID      string  `json:"sourceId" msgpack:"sourceId"`
		NewItemsCount float64 `json:"newItemsCount" msgpack:"newItemsCount"`
	}
	payload := payloadExample{OrgID: "org:abc", SourceID: "cls-hot", NewItemsCount: 2}
	encoded, err := encodeAdapterBroadcast("XYZ123", "/newsnow", []string{"org:abc"}, []string{"user:u1"}, "newsnow:update", payload)
	if err != nil {
		t.Fatalf("encodeAdapterBroadcast() error = %v", err)
	}
	message, err := decodeAdapterMessage(encoded)
	if err != nil {
		t.Fatalf("decodeAdapterMessage() error = %v", err)
	}
	if message.UID != "XYZ123" {
		t.Fatalf("uid = %q", message.UID)
	}
	if got, want := string(message.PayloadJSON), `{"orgId":"org:abc","sourceId":"cls-hot","newItemsCount":2}`; got != want {
		t.Fatalf("payload = %s, want %s", got, want)
	}
	if len(message.Except) != 1 || message.Except[0] != "user:u1" {
		t.Fatalf("except = %#v", message.Except)
	}
}

func TestDecodeAdapterMessagePreservesDateAndRejectsBinary(t *testing.T) {
	stamp := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	type payloadWithDate struct {
		At time.Time `json:"at" msgpack:"at"`
	}
	encoded, err := encodeAdapterBroadcast("XYZ123", "/newsnow", []string{"org:abc"}, nil, "newsnow:update", payloadWithDate{At: stamp})
	if err != nil {
		t.Fatalf("encodeAdapterBroadcast() error = %v", err)
	}
	message, err := decodeAdapterMessage(encoded)
	if err != nil {
		t.Fatalf("decodeAdapterMessage() error = %v", err)
	}
	if got, want := string(message.PayloadJSON), `{"at":"2026-10-20T12:00:00.000Z"}`; got != want {
		t.Fatalf("payload = %s, want %s", got, want)
	}

	// A binary payload has no JSON representation on this transport.
	binaryPayload := []byte{0x01, 0x02}
	encoded, err = encodeAdapterBroadcast("XYZ123", "/newsnow", []string{"org:abc"}, nil, "newsnow:update", binaryPayload)
	if err != nil {
		t.Fatalf("encodeAdapterBroadcast(binary) error = %v", err)
	}
	if _, err := decodeAdapterMessage(encoded); err == nil {
		t.Fatal("decodeAdapterMessage() should reject a binary payload")
	}
}

func TestAdapterChannelAndRoom(t *testing.T) {
	if got := adapterChannel("socket.io", "/newsnow", ""); got != "socket.io#/newsnow#" {
		t.Fatalf("base channel = %q", got)
	}
	if got := adapterChannel("socket.io", "/newsnow", "org:abc"); got != "socket.io#/newsnow#org:abc#" {
		t.Fatalf("room channel = %q", got)
	}
	if got := adapterPattern("mysocket", "/newsnow"); got != "mysocket#/newsnow#*" {
		t.Fatalf("pattern = %q", got)
	}
	if got := adapterMessageChannelRoom("socket.io#/newsnow#org:abc#", "socket.io", "/newsnow"); got != "org:abc" {
		t.Fatalf("room = %q", got)
	}
	if got := adapterMessageChannelRoom("socket.io#/newsnow#", "socket.io", "/newsnow"); got != "" {
		t.Fatalf("base room = %q", got)
	}
	if got := adapterMessageChannelRoom("socket.io#/ops#org:abc#", "socket.io", "/newsnow"); got != "" {
		t.Fatalf("foreign namespace room = %q", got)
	}
}

func TestFormatJSNumber(t *testing.T) {
	cases := map[float64]string{
		2:      "2",
		-0:     "0",
		1.5:    "1.5",
		1000:   "1000",
		1e21:   "1e+21",
		0.0001: "0.0001",
	}
	for value, want := range cases {
		if got := formatJSNumber(value); got != want {
			t.Fatalf("formatJSNumber(%v) = %q, want %q", value, got, want)
		}
	}
}

func TestJSONObjectFieldAppendingToDecodedFrame(t *testing.T) {
	message, err := decodeAdapterMessage(adapterExampleBytes(t))
	if err != nil {
		t.Fatalf("decodeAdapterMessage() error = %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(message.PayloadJSON, &decoded); err != nil {
		t.Fatalf("payload is not a JSON object: %v", err)
	}
}
