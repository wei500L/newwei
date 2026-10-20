package telegramclient

import (
	"context"
	"errors"
	"testing"

	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// fakeAuthAPI is an authAPI double.
type fakeAuthAPI struct {
	sent        tg.AuthSentCodeClass
	sendErr     error
	sendErrSeq  []error
	sendCalls   int
	sendPhone   string
	sendOptions auth.SendCodeOptions

	signInErr   error
	signInCalls int
	signInPhone string
	signInCode  string
	signInHash  string

	passwordErr   error
	passwordCalls int
	passwordValue string
}

func (f *fakeAuthAPI) SendCode(_ context.Context, phone string, options auth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	f.sendCalls++
	f.sendPhone = phone
	f.sendOptions = options
	if len(f.sendErrSeq) > 0 {
		err := f.sendErrSeq[0]
		f.sendErrSeq = f.sendErrSeq[1:]
		if err != nil {
			return nil, err
		}
		return f.sent, nil
	}
	if f.sendErr != nil {
		return nil, f.sendErr
	}
	return f.sent, nil
}

func (f *fakeAuthAPI) SignIn(_ context.Context, phone, code, codeHash string) (*tg.AuthAuthorization, error) {
	f.signInCalls++
	f.signInPhone = phone
	f.signInCode = code
	f.signInHash = codeHash
	if f.signInErr != nil {
		return nil, f.signInErr
	}
	return &tg.AuthAuthorization{}, nil
}

func (f *fakeAuthAPI) Password(_ context.Context, password string) (*tg.AuthAuthorization, error) {
	f.passwordCalls++
	f.passwordValue = password
	if f.passwordErr != nil {
		return nil, f.passwordErr
	}
	return &tg.AuthAuthorization{}, nil
}

func newAuthTestClient(t *testing.T, fake *fakeAuthAPI) *Client {
	t.Helper()
	client, err := New(Options{APIID: 1, APIHash: "test-api-hash"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	client.auth = fake
	return client
}

func TestSendCode(t *testing.T) {
	tests := []struct {
		name       string
		sent       tg.AuthSentCodeClass
		sendErr    error
		wantHash   string
		wantViaApp bool
		wantErr    error
		wantFlood  bool
	}{
		{
			name:       "app code",
			sent:       &tg.AuthSentCode{PhoneCodeHash: "hash-app", Type: &tg.AuthSentCodeTypeApp{Length: 5}},
			wantHash:   "hash-app",
			wantViaApp: true,
		},
		{
			name:       "sms code",
			sent:       &tg.AuthSentCode{PhoneCodeHash: "hash-sms", Type: &tg.AuthSentCodeTypeSMS{Length: 6}},
			wantHash:   "hash-sms",
			wantViaApp: false,
		},
		{
			name:       "already authorized",
			sent:       &tg.AuthSentCodeSuccess{},
			wantErr:    ErrAlreadyAuthorized,
			wantViaApp: false,
		},
		{
			name:      "flood wait",
			sendErr:   tgerr.New(420, "FLOOD_WAIT_4"),
			wantFlood: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeAuthAPI{sent: tt.sent, sendErr: tt.sendErr}
			client := newAuthTestClient(t, fake)

			sent, err := client.SendCode(context.Background(), "+15551234567")
			if fake.sendPhone != "+15551234567" {
				t.Errorf("fake send phone = %q, want the phone passed through", fake.sendPhone)
			}
			if fake.sendOptions != (auth.SendCodeOptions{}) {
				t.Errorf("send options = %+v, want zero options like GramJS CodeSettings{}", fake.sendOptions)
			}
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("SendCode() error = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.wantFlood:
				if !IsFloodWait(err) {
					t.Fatalf("SendCode() error = %v, want flood wait", err)
				}
				if got := FloodWaitSeconds(err); got != 4 {
					t.Errorf("FloodWaitSeconds() = %d, want 4", got)
				}
				return
			case err != nil:
				t.Fatalf("SendCode() error = %v", err)
			}
			if sent.PhoneCodeHash != tt.wantHash {
				t.Errorf("PhoneCodeHash = %q, want %q", sent.PhoneCodeHash, tt.wantHash)
			}
			if sent.CodeViaApp != tt.wantViaApp {
				t.Errorf("CodeViaApp = %v, want %v", sent.CodeViaApp, tt.wantViaApp)
			}
		})
	}
}

func TestSendCodeRetriesAuthRestartOnce(t *testing.T) {
	fake := &fakeAuthAPI{
		sent:       &tg.AuthSentCode{PhoneCodeHash: "hash", Type: &tg.AuthSentCodeTypeApp{Length: 5}},
		sendErrSeq: []error{tgerr.New(500, "AUTH_RESTART")},
	}
	client := newAuthTestClient(t, fake)

	sent, err := client.SendCode(context.Background(), "+1555")
	if err != nil {
		t.Fatalf("SendCode() error = %v", err)
	}
	if sent.PhoneCodeHash != "hash" {
		t.Errorf("PhoneCodeHash = %q", sent.PhoneCodeHash)
	}
	if fake.sendCalls != 2 {
		t.Errorf("send code calls = %d, want 2 (AUTH_RESTART retried once)", fake.sendCalls)
	}
}

func TestSendCodeDoesNotRetryOtherErrors(t *testing.T) {
	fake := &fakeAuthAPI{
		sendErr: tgerr.New(400, "PHONE_NUMBER_INVALID"),
	}
	client := newAuthTestClient(t, fake)

	if _, err := client.SendCode(context.Background(), "+1555"); err == nil {
		t.Fatal("SendCode() error = nil, want error")
	}
	if fake.sendCalls != 1 {
		t.Errorf("send code calls = %d, want 1", fake.sendCalls)
	}
}

func TestSignInArgumentOrder(t *testing.T) {
	fake := &fakeAuthAPI{}
	client := newAuthTestClient(t, fake)

	if err := client.SignIn(context.Background(), "+15551234567", "phone-code-hash", "12345"); err != nil {
		t.Fatalf("SignIn() error = %v", err)
	}
	if fake.signInCalls != 1 {
		t.Fatalf("sign in calls = %d, want 1", fake.signInCalls)
	}
	if fake.signInPhone != "+15551234567" {
		t.Errorf("phone = %q", fake.signInPhone)
	}
	// gotd auth.SignIn(ctx, phone, code, codeHash); the public method takes
	// (phone, phoneCodeHash, code) like the contract, so the order must flip.
	if fake.signInCode != "12345" {
		t.Errorf("code = %q, want 12345", fake.signInCode)
	}
	if fake.signInHash != "phone-code-hash" {
		t.Errorf("code hash = %q, want phone-code-hash", fake.signInHash)
	}
}

func TestSignInPasswordNeeded(t *testing.T) {
	fake := &fakeAuthAPI{signInErr: auth.ErrPasswordAuthNeeded}
	client := newAuthTestClient(t, fake)

	err := client.SignIn(context.Background(), "+1555", "hash", "code")
	if !errors.Is(err, ErrPasswordNeeded) {
		t.Errorf("SignIn() error = %v, want ErrPasswordNeeded", err)
	}
}

func TestSignInSignUpRequired(t *testing.T) {
	fake := &fakeAuthAPI{signInErr: &auth.SignUpRequired{}}
	client := newAuthTestClient(t, fake)

	err := client.SignIn(context.Background(), "+1555", "hash", "code")
	if !errors.Is(err, ErrSignUpRequired) {
		t.Errorf("SignIn() error = %v, want ErrSignUpRequired", err)
	}
}

func TestSignInPassesThroughTelegramError(t *testing.T) {
	fake := &fakeAuthAPI{signInErr: tgerr.New(400, "PHONE_CODE_INVALID")}
	client := newAuthTestClient(t, fake)

	err := client.SignIn(context.Background(), "+1555", "hash", "code")
	if got := ErrorDescription(err); got != "PHONE_CODE_INVALID" {
		t.Errorf("ErrorDescription() = %q, want PHONE_CODE_INVALID", got)
	}
	if errors.Is(err, ErrPasswordNeeded) || errors.Is(err, ErrSignUpRequired) {
		t.Errorf("SignIn() error = %v, must not be normalized to a sentinel", err)
	}
}

func TestSignInWithPassword(t *testing.T) {
	fake := &fakeAuthAPI{}
	client := newAuthTestClient(t, fake)

	// Telegram does not trim passwords; the value must be passed verbatim.
	const password = "  s3cret pass  "
	if err := client.SignInWithPassword(context.Background(), password); err != nil {
		t.Fatalf("SignInWithPassword() error = %v", err)
	}
	if fake.passwordCalls != 1 {
		t.Fatalf("password calls = %d, want 1", fake.passwordCalls)
	}
	if fake.passwordValue != password {
		t.Errorf("password = %q, want %q", fake.passwordValue, password)
	}
}

func TestSignInWithPasswordInvalid(t *testing.T) {
	fake := &fakeAuthAPI{passwordErr: auth.ErrPasswordInvalid}
	client := newAuthTestClient(t, fake)

	if err := client.SignInWithPassword(context.Background(), "wrong"); !errors.Is(err, auth.ErrPasswordInvalid) {
		t.Errorf("SignInWithPassword() error = %v, want auth.ErrPasswordInvalid", err)
	}
}
