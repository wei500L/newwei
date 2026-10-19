package queue

import (
	"encoding/hex"
	"testing"
)

func TestMarshalMsgpackGolden(t *testing.T) {
	cases := []struct {
		name  string
		value any
		hex   string
	}{
		{"nil", nil, "c0"},
		{"true", true, "c3"},
		{"false", false, "c2"},
		{"zero", 0, "00"},
		{"127", 127, "7f"},
		{"128", 128, "cc80"},
		{"30000", 30000, "cd7530"},
		{"negative fixint", -1, "ff"},
		{"int8", -33, "d0df"},
		{"int16", -129, "d1ff7f"},
		{"empty string", "", "a0"},
		{"short string", "abc", "a3616263"},
		{"array", []any{"a", 1, nil}, "93a16101c0"},
		{"nested", map[string]any{"a": []any{int64(1)}}, "81a1619101"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := MarshalMsgpack(tc.value)
			if err != nil {
				t.Fatalf("MarshalMsgpack(%v): %v", tc.value, err)
			}
			if got := hex.EncodeToString(encoded); got != tc.hex {
				t.Fatalf("MarshalMsgpack(%v) = %s, want %s", tc.value, got, tc.hex)
			}
		})
	}
}

func TestMarshalMsgpackMapKeyOrderIsStable(t *testing.T) {
	value := map[string]any{"b": int64(2), "a": int64(1)}
	first, err := MarshalMsgpack(value)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for attempt := 0; attempt < 20; attempt++ {
		next, err := MarshalMsgpack(value)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if string(next) != string(first) {
			t.Fatalf("encoding is not stable: %x vs %x", first, next)
		}
	}
	// 0x81 0xa1 'a' 0x01 0xa1 'b' 0x02
	if got := hex.EncodeToString(first); got != "81a16101a16202" {
		t.Fatalf("encoded = %s", got)
	}
}

func TestMarshalMsgpackRejectsUnknownTypes(t *testing.T) {
	if _, err := MarshalMsgpack(struct{}{}); err == nil {
		t.Fatal("expected an error for an unsupported Go type")
	}
}

func TestMarshalMsgpackFloat(t *testing.T) {
	encoded, err := MarshalMsgpack(1.5)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := []byte{0xcb, 0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	if string(encoded) != string(want) {
		t.Fatalf("float64 encoding = %x, want %x", encoded, want)
	}
}
