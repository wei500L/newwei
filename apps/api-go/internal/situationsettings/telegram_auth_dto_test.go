package situationsettings

import (
	"errors"
	"strings"
	"testing"
)

// These tests pin the ValidationPipe semantics of the two telegram-auth DTOs.
// The expected strings are class-validator's default messages joined by
// GlobalExceptionFilter with "; " (validationErrors joined exactly like the
// other DTO in this package).
//
// Constraint order inside one property follows the registration order of the
// decorators, which TypeScript applies bottom-up: @Matches is called before
// @IsString, so class-validator registers matches first and the joined message
// is "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string".
// Verified against the installed class-validator@0.14.2 with a Node one-liner
// (no build step); the current spec notes (nest-auth-spec §5 first row and
// §9.3 example) have this one order reversed.

func TestParseStartTelegramAuthValidationMatrix(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantErr string
		want    StartTelegramAuthInput
	}{
		{
			name: "minimal valid body",
			body: `{"phoneNumber":"+14155552671"}`,
			want: StartTelegramAuthInput{
				TelegramAPIID:   optionalString{state: presenceMissing},
				TelegramAPIHash: optionalString{state: presenceMissing},
				PhoneNumber:     "+14155552671",
			},
		},
		{
			name: "credentials and null optionals",
			body: `{"telegramApiId":"12345","telegramApiHash":"hash","phoneNumber":"+14155552671"}`,
			want: StartTelegramAuthInput{
				TelegramAPIID:   optionalString{state: presenceValue, value: "12345"},
				TelegramAPIHash: optionalString{state: presenceValue, value: "hash"},
				PhoneNumber:     "+14155552671",
			},
		},
		{
			name: "null optionals pass IsOptional",
			body: `{"telegramApiId":null,"telegramApiHash":null,"phoneNumber":"+14155552671"}`,
			want: StartTelegramAuthInput{
				TelegramAPIID:   optionalString{state: presenceNull},
				TelegramAPIHash: optionalString{state: presenceNull},
				PhoneNumber:     "+14155552671",
			},
		},
		{
			name:    "missing phone number fails Matches and IsString",
			body:    `{}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string",
		},
		{
			name:    "null phone number fails Matches and IsString",
			body:    `{"phoneNumber":null}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string",
		},
		{
			name:    "numeric phone number fails both constraints",
			body:    `{"phoneNumber":14155552671}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string",
		},
		{
			name:    "phone without plus",
			body:    `{"phoneNumber":"14155552671"}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID",
		},
		{
			name:    "phone with leading zero country code",
			body:    `{"phoneNumber":"+0123456789"}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID",
		},
		{
			name:    "phone too short",
			body:    `{"phoneNumber":"+123456"}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID",
		},
		{
			name:    "phone too long",
			body:    `{"phoneNumber":"+1234567890123456"}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID",
		},
		{
			name:    "phone with spaces fails Matches",
			body:    `{"phoneNumber":" +14155552671"}`,
			wantErr: "TELEGRAM_AUTH_PHONE_FORMAT_INVALID",
		},
		{
			name:    "telegramApiId must be a string",
			body:    `{"telegramApiId":123,"phoneNumber":"+14155552671"}`,
			wantErr: "telegramApiId must be a string",
		},
		{
			name:    "telegramApiHash must be a string",
			body:    `{"telegramApiHash":true,"phoneNumber":"+14155552671"}`,
			wantErr: "telegramApiHash must be a string",
		},
		{
			name:    "unknown property is rejected before declared properties",
			body:    `{"foo":1,"phoneNumber":"+14155552671","bar":2}`,
			wantErr: "property foo should not exist; property bar should not exist",
		},
		{
			name:    "unknown property and missing phone keep whitelist-first order",
			body:    `{"foo":1}`,
			wantErr: "property foo should not exist; TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string",
		},
		{
			name: "duplicate key keeps the last JSON.parse value",
			body: `{"phoneNumber":1,"phoneNumber":"+14155552671"}`,
			want: StartTelegramAuthInput{
				TelegramAPIID:   optionalString{state: presenceMissing},
				TelegramAPIHash: optionalString{state: presenceMissing},
				PhoneNumber:     "+14155552671",
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := parseStartTelegramAuth([]byte(testCase.body))
			if testCase.wantErr != "" {
				if err == nil {
					t.Fatalf("parseStartTelegramAuth(%s) = %+v, want error %q", testCase.body, got, testCase.wantErr)
				}
				if err.Error() != testCase.wantErr {
					t.Fatalf("error = %q, want %q", err.Error(), testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseStartTelegramAuth(%s) error = %v", testCase.body, err)
			}
			if got != testCase.want {
				t.Fatalf("parseStartTelegramAuth(%s) = %+v, want %+v", testCase.body, got, testCase.want)
			}
		})
	}
}

func TestParseCompleteTelegramAuthValidationMatrix(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantErr string
		want    CompleteTelegramAuthInput
	}{
		{
			name: "minimal valid body",
			body: `{"requestId":"req-1","phoneCode":"12345"}`,
			want: CompleteTelegramAuthInput{
				RequestID:      "req-1",
				PhoneCode:      "12345",
				Password:       optionalString{state: presenceMissing},
				EnableTelegram: optionalBool{state: presenceMissing},
			},
		},
		{
			name: "full body",
			body: `{"requestId":"req-1","phoneCode":"12345","password":"secret","enableTelegram":true}`,
			want: CompleteTelegramAuthInput{
				RequestID:      "req-1",
				PhoneCode:      "12345",
				Password:       optionalString{state: presenceValue, value: "secret"},
				EnableTelegram: optionalBool{state: presenceValue, value: true},
			},
		},
		{
			name: "null optional members pass IsOptional",
			body: `{"requestId":"req-1","phoneCode":"12345","password":null,"enableTelegram":null}`,
			want: CompleteTelegramAuthInput{
				RequestID:      "req-1",
				PhoneCode:      "12345",
				Password:       optionalString{state: presenceNull},
				EnableTelegram: optionalBool{state: presenceNull},
			},
		},
		{
			name: "explicit false enableTelegram",
			body: `{"requestId":"req-1","phoneCode":"12345","enableTelegram":false}`,
			want: CompleteTelegramAuthInput{
				RequestID:      "req-1",
				PhoneCode:      "12345",
				Password:       optionalString{state: presenceMissing},
				EnableTelegram: optionalBool{state: presenceValue},
			},
		},
		{
			name:    "missing both required members in declaration order",
			body:    `{}`,
			wantErr: "requestId must be a string; phoneCode must be a string",
		},
		{
			name:    "missing requestId only",
			body:    `{"phoneCode":"12345"}`,
			wantErr: "requestId must be a string",
		},
		{
			name:    "null requestId fails IsString",
			body:    `{"requestId":null,"phoneCode":"12345"}`,
			wantErr: "requestId must be a string",
		},
		{
			name:    "numeric requestId",
			body:    `{"requestId":1,"phoneCode":"12345"}`,
			wantErr: "requestId must be a string",
		},
		{
			name:    "numeric phoneCode",
			body:    `{"requestId":"req-1","phoneCode":12345}`,
			wantErr: "phoneCode must be a string",
		},
		{
			name:    "numeric password",
			body:    `{"requestId":"req-1","phoneCode":"12345","password":1}`,
			wantErr: "password must be a string",
		},
		{
			name:    "string enableTelegram fails IsBoolean",
			body:    `{"requestId":"req-1","phoneCode":"12345","enableTelegram":"true"}`,
			wantErr: "enableTelegram must be a boolean value",
		},
		{
			name:    "numeric enableTelegram fails IsBoolean",
			body:    `{"requestId":"req-1","phoneCode":"12345","enableTelegram":1}`,
			wantErr: "enableTelegram must be a boolean value",
		},
		{
			name:    "unknown property rejected before declared properties",
			body:    `{"requestId":"req-1","phoneCode":"12345","extra":true}`,
			wantErr: "property extra should not exist",
		},
		{
			name:    "property order is DTO declaration order",
			body:    `{"enableTelegram":1,"requestId":2}`,
			wantErr: "requestId must be a string; phoneCode must be a string; enableTelegram must be a boolean value",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := parseCompleteTelegramAuth([]byte(testCase.body))
			if testCase.wantErr != "" {
				if err == nil {
					t.Fatalf("parseCompleteTelegramAuth(%s) = %+v, want error %q", testCase.body, got, testCase.wantErr)
				}
				if err.Error() != testCase.wantErr {
					t.Fatalf("error = %q, want %q", err.Error(), testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseCompleteTelegramAuth(%s) error = %v", testCase.body, err)
			}
			if got != testCase.want {
				t.Fatalf("parseCompleteTelegramAuth(%s) = %+v, want %+v", testCase.body, got, testCase.want)
			}
		})
	}
}

func TestTelegramAuthDTORejectsNonObjectBodies(t *testing.T) {
	cases := map[string]string{
		`not json`:  "Unexpected token in JSON body",
		`[]`:        "Invalid request body",
		`"string"`:  "Invalid request body",
		`42`:        "Invalid request body",
		`true`:      "Invalid request body",
		`{"a":}`:    "Invalid request body",
		"{broken":   "Unexpected token in JSON body",
		`[{"a":1}]`: "Invalid request body",
	}
	for body, want := range cases {
		if _, err := parseStartTelegramAuth([]byte(body)); err == nil || err.Error() != want {
			t.Fatalf("parseStartTelegramAuth(%q) error = %v, want %q", body, err, want)
		}
		if _, err := parseCompleteTelegramAuth([]byte(body)); err == nil || err.Error() != want {
			t.Fatalf("parseCompleteTelegramAuth(%q) error = %v, want %q", body, err, want)
		}
	}
}

func TestTelegramAuthDTOMessagesAreJoinable(t *testing.T) {
	_, err := parseStartTelegramAuth([]byte(`{"foo":1}`))
	if err == nil {
		t.Fatal("expected validation error")
	}
	var coded *httpError
	if !errors.As(err, &coded) {
		t.Fatalf("validation error must be a flat httpError, got %T", err)
	}
	if coded.status != 400 {
		t.Fatalf("status = %d, want 400", coded.status)
	}
	if !strings.Contains(coded.message, "; ") {
		t.Fatalf("message = %q, want the joined ValidationPipe array", coded.message)
	}
}
