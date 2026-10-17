package authfactors

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// rfc6238Secret is the RFC 6238 / RFC 4226 Appendix test secret: the ASCII
// string "12345678901234567890" in unpadded uppercase Base32.
const rfc6238Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

// TestEncodeBase32RoundTripAndAlphabet locks the RFC 4648 alphabet and the
// unpadded 32 character shape of a 20 byte secret.
func TestEncodeBase32RoundTripAndAlphabet(t *testing.T) {
	secret, err := generateTotpSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(secret) != 32 {
		t.Fatalf("secret length = %d, want 32 (%q)", len(secret), secret)
	}
	for _, ch := range secret {
		if !(ch >= 'A' && ch <= 'Z') && !(ch >= '2' && ch <= '7') {
			t.Fatalf("secret %q contains %q outside the RFC 4648 alphabet", secret, ch)
		}
	}
	if strings.Contains(secret, "=") {
		t.Fatalf("secret %q must not be padded", secret)
	}

	raw := []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
		0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13}
	encoded := encodeBase32(raw)
	if len(encoded) != 32 {
		t.Fatalf("encoded length = %d (%q)", len(encoded), encoded)
	}
	decoded, err := decodeBase32(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, raw) {
		t.Fatalf("round trip mismatch: %x != %x", decoded, raw)
	}
}

// TestDecodeBase32NormalizesInput locks trim + uppercase + trailing padding
// removal, exactly like decodeBase32 in auth-flow.utils.ts.
func TestDecodeBase32NormalizesInput(t *testing.T) {
	want, err := decodeBase32(rfc6238Secret)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != "12345678901234567890" {
		t.Fatalf("decoded = %q", want)
	}
	for _, variant := range []string{
		"  " + rfc6238Secret + "  ",
		strings.ToLower(rfc6238Secret),
		rfc6238Secret + "====",
		strings.ToLower(rfc6238Secret) + "=",
	} {
		got, err := decodeBase32(variant)
		if err != nil {
			t.Fatalf("decode %q: %v", variant, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("decode %q = %x, want %x", variant, got, want)
		}
	}
	if _, err := decodeBase32("0189"); err == nil {
		t.Fatal("invalid base32 characters must be rejected")
	}
}

// TestGenerateTotpAtRFC6238Vectors locks the algorithm against the published
// RFC 6238 SHA-1 vectors truncated to six digits. Three of them exercise the
// leading-zero padding (081804, 050471, 005924).
func TestGenerateTotpAtRFC6238Vectors(t *testing.T) {
	cases := []struct {
		counter uint64
		want    string
	}{
		{1, "287082"},         // T = 59
		{37037036, "081804"},  // T = 1111111109
		{37037037, "050471"},  // T = 1111111111
		{41152263, "005924"},  // T = 1234567890
		{66666666, "279037"},  // T = 2000000000
		{666666666, "353130"}, // T = 20000000000
	}
	for _, tc := range cases {
		got, err := generateTotpAt(rfc6238Secret, tc.counter)
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Fatalf("counter %d = %q, want %q", tc.counter, got, tc.want)
		}
		if len(got) != totpCodeDigits {
			t.Fatalf("counter %d code %q must be %d digits", tc.counter, got, totpCodeDigits)
		}
	}
}

// TestVerifyTotpCodeAcceptsWindow locks the ±1 counter window and the exact six
// digit requirement.
func TestVerifyTotpCodeAcceptsWindow(t *testing.T) {
	counter := time.Now().Unix() / totpPeriodSecond
	for offset := -totpWindow; offset <= totpWindow; offset++ {
		code, err := generateTotpAt(rfc6238Secret, uint64(counter+int64(offset)))
		if err != nil {
			t.Fatal(err)
		}
		if !verifyTotpCode(rfc6238Secret, code) {
			t.Fatalf("offset %d code %q must be accepted", offset, code)
		}
		// Whitespace around the code is trimmed before matching.
		if !verifyTotpCode(rfc6238Secret, "  "+code+" ") {
			t.Fatalf("offset %d code %q must be accepted after trimming", offset, code)
		}
	}

	current, err := generateTotpAt(rfc6238Secret, uint64(counter))
	if err != nil {
		t.Fatal(err)
	}
	if verifyTotpCode(rfc6238Secret, "0"+current) {
		t.Fatal("a seven digit code must be rejected")
	}
	if verifyTotpCode(rfc6238Secret, current[:5]) {
		t.Fatal("a five digit code must be rejected")
	}
	if verifyTotpCode(rfc6238Secret, current[:5]+"x") {
		t.Fatal("a non-numeric six character code must be rejected")
	}
	if verifyTotpCode("not-base32!", current) {
		t.Fatal("an undecodable secret must never verify")
	}
}

// TestBuildOtpAuthURIMatchesEncodeURIComponent locks the exact URI structure and
// the JavaScript encodeURIComponent semantics.
func TestBuildOtpAuthURIMatchesEncodeURIComponent(t *testing.T) {
	secret, err := generateTotpSecret()
	if err != nil {
		t.Fatal(err)
	}
	// encodeURIComponent escapes "@" as %40 and "+" as %2B: only
	// A-Za-z0-9-_.!~*'() stay literal.
	account := "first.last+tag@example.com"
	uri := buildOtpAuthURI(account, secret)
	want := "otpauth://totp/Modular:first.last%2Btag%40example.com" +
		"?secret=" + secret +
		"&issuer=Modular&algorithm=SHA1&digits=6&period=30"
	if uri != want {
		t.Fatalf("uri = %q, want %q", uri, want)
	}

	// encodeURIComponent leaves the documented unreserved set alone and
	// percent-encodes everything else with uppercase hex (never a form "+").
	encodeCases := []struct{ in, want string }{
		{"Modular", "Modular"},
		{"a b", "a%20b"},
		{"a+b", "a%2Bb"},
		{"a&b=c", "a%26b%3Dc"},
		{"a/b?c:d", "a%2Fb%3Fc%3Ad"},
		{"-_.!~*'()", "-_.!~*'()"},
		{"a@b", "a%40b"},
		{"user@example.com", "user%40example.com"},
		{"caf\u00e9", "caf%C3%A9"},
		{"\u4e2d", "%E4%B8%AD"},
		{"100%", "100%25"},
	}
	for _, tc := range encodeCases {
		if got := encodeURIComponent(tc.in); got != tc.want {
			t.Fatalf("encodeURIComponent(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	// A colon in the account name must be encoded, so the URI keeps exactly one
	// separator colon between the issuer label and the account name.
	colonURI := buildOtpAuthURI("a:b", secret)
	if !strings.HasPrefix(colonURI, "otpauth://totp/Modular:a%3Ab?secret=") {
		t.Fatalf("colon account uri = %q", colonURI)
	}
}
