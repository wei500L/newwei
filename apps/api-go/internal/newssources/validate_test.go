package newssources

import (
	"context"
	"strings"
	"testing"
)

// TestUTF16LengthMatchesJavaScript pins the length unit class-validator's
// MaxLength uses: UTF-16 code units, astral runes counted twice.
func TestUTF16LengthMatchesJavaScript(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"", 0},
		{"abc", 3},
		{"中文", 2},
		{"😀", 2},
		{"a😀b", 4},
	}
	for _, tc := range cases {
		if got := utf16Length(tc.value); got != tc.want {
			t.Fatalf("utf16Length(%q) = %d, want %d", tc.value, got, tc.want)
		}
	}
}

// TestSourceNameLengthCountsUTF16CodeUnits keeps names that NestJS accepted:
// 200 CJK code units are 600 UTF-8 bytes but only 200 code units, so the byte
// length used to reject them.
func TestSourceNameLengthCountsUTF16CodeUnits(t *testing.T) {
	urlField := `"url":"http://8.8.8.8/feed"`
	accepted := `{"name":"` + strings.Repeat("新", 200) + `",` + urlField + `}`
	if _, err := parseCreate(context.Background(), []byte(accepted)); err != nil {
		t.Fatalf("200 UTF-16 code units rejected: %v", err)
	}
	rejected := `{"name":"` + strings.Repeat("新", 201) + `",` + urlField + `}`
	if _, err := parseCreate(context.Background(), []byte(rejected)); err == nil {
		t.Fatal("201 UTF-16 code units accepted")
	}
}

// TestSourceLanguageLengthCountsUTF16CodeUnits covers the 12 code unit limit on
// language: five CJK runes are 12 UTF-8 bytes but only five code units.
func TestSourceLanguageLengthCountsUTF16CodeUnits(t *testing.T) {
	body := `{"name":"source","url":"http://8.8.8.8/feed","language":"日本語です"}`
	input, err := parseCreate(context.Background(), []byte(body))
	if err != nil {
		t.Fatalf("five CJK language runes rejected: %v", err)
	}
	if input.Language == nil || *input.Language != "日本語です" {
		t.Fatalf("language = %v", input.Language)
	}
	tooLong := `{"name":"source","url":"http://8.8.8.8/feed","language":"` + strings.Repeat("語", 13) + `"}`
	if _, err := parseCreate(context.Background(), []byte(tooLong)); err == nil {
		t.Fatal("13 code unit language accepted")
	}
}

// TestListQueryLengthCountsUTF16CodeUnits covers `search` (200) and `group`
// (191) like the ListNewsSourceDto MaxLength decorators.
func TestListQueryLengthCountsUTF16CodeUnits(t *testing.T) {
	if _, err := parseListQuery(map[string][]string{"search": {strings.Repeat("新", 200)}}); err != nil {
		t.Fatalf("200 code unit search rejected: %v", err)
	}
	if _, err := parseListQuery(map[string][]string{"search": {strings.Repeat("新", 201)}}); err == nil {
		t.Fatal("201 code unit search accepted")
	}
	query, err := parseListQuery(map[string][]string{"group": {strings.Repeat("新", 191)}})
	if err != nil {
		t.Fatalf("191 code unit group rejected: %v", err)
	}
	if query.Group == nil {
		t.Fatal("group filter not set")
	}
	if _, err := parseListQuery(map[string][]string{"group": {strings.Repeat("新", 192)}}); err == nil {
		t.Fatal("192 code unit group accepted")
	}
}

// TestBatchIDsLengthCountsUTF16CodeUnits covers NewsSourceIdsDto
// @MaxLength(191, {each: true}).
func TestBatchIDsLengthCountsUTF16CodeUnits(t *testing.T) {
	allowed := `{"ids":["` + strings.Repeat("新", 191) + `"]}`
	if _, _, _, _, err := parseIDs([]byte(allowed), false, false); err != nil {
		t.Fatalf("191 code unit id rejected: %v", err)
	}
	rejected := `{"ids":["` + strings.Repeat("新", 192) + `"]}`
	if _, _, _, _, err := parseIDs([]byte(rejected), false, false); err == nil {
		t.Fatal("192 code unit id accepted")
	}
}

// TestNormalizeLanguageCountsUTF16CodeUnits covers the 12 code unit branch of
// normalizeLanguage.
func TestNormalizeLanguageCountsUTF16CodeUnits(t *testing.T) {
	if got := normalizeLanguage("日本語です"); got != "日本語です" {
		t.Fatalf("normalizeLanguage = %q, want the five rune tag", got)
	}
	if got := normalizeLanguage(strings.Repeat("語", 13)); got != "zh" {
		t.Fatalf("normalizeLanguage = %q, want zh", got)
	}
}
