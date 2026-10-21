package itempipeline

import "testing"

func TestIsValidObjectIDMatchesMongoose(t *testing.T) {
	cases := []struct {
		value string
		valid bool
	}{
		{"507f1f77bcf86cd799439011", true},
		{"507F1F77BCF86CD799439011", true},
		{"507f1f77bcf86cd79943901", false},   // 23 chars
		{"507f1f77bcf86cd7994390111", false}, // 25 chars
		{"507f1f77bcf86cd79943901z", false},  // 24 chars but not hex
		{"abc12345", false},                  // 8 chars
		{"abcdefghijkl", true},               // 12 bytes, any characters
		{"", false},
	}
	for _, testCase := range cases {
		if got := isValidObjectID(testCase.value); got != testCase.valid {
			t.Errorf("isValidObjectID(%q) = %v, want %v", testCase.value, got, testCase.valid)
		}
	}
}

func TestObjectIDFromJSValueUsesByteSemanticsFor12ByteStrings(t *testing.T) {
	objectID, ok := objectIDFromJSValue("abcdefghijkl")
	if !ok {
		t.Fatal("12-byte string must be a valid ObjectId")
	}
	if got := objectID.Hex(); got != "6162636465666768696a6b6c" {
		t.Fatalf("12-byte ObjectId hex = %s", got)
	}
	hexID, ok := objectIDFromJSValue("507f1f77bcf86cd799439011")
	if !ok || hexID.Hex() != "507f1f77bcf86cd799439011" {
		t.Fatalf("24-hex ObjectId = %v %v", hexID.Hex(), ok)
	}
	if _, ok := objectIDFromJSValue("not-an-object-id"); ok {
		t.Fatal("invalid value must not convert")
	}
}
