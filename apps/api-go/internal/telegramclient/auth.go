package telegramclient

import (
	"context"
	"errors"
	"fmt"

	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// SentCode is the result of SendCode.
type SentCode struct {
	// PhoneCodeHash is the auth.sendCode hash required by SignIn.
	PhoneCodeHash string
	// CodeViaApp is true when Telegram delivered the code in-app (GramJS
	// sentCode.isCodeViaApp), false for SMS/call/flash-call delivery.
	CodeViaApp bool
}

var (
	// ErrPasswordNeeded is returned by SignIn when the account has 2FA enabled.
	// The caller must collect the password and call SignInWithPassword.
	ErrPasswordNeeded = errors.New("telegramclient: password needed")
	// ErrSignUpRequired is returned by SignIn when no account exists for the
	// phone number.
	ErrSignUpRequired = errors.New("telegramclient: sign up required")
	// ErrAlreadyAuthorized is returned by SendCode when Telegram replies that
	// the client is already logged in (auth.sentCodeSuccess). GramJS raises the
	// same condition instead of sending a code.
	ErrAlreadyAuthorized = errors.New("telegramclient: already authorized")
)

// SendCode requests a login code for the phone number. It must be called on a
// started temporary (unauthenticated) client.
//
// AUTH_RESTART is retried once, like GramJS client.sendCode
// (client/auth.js:295-298); every other Telegram error is returned with its
// tgerr type intact. The phone number, the returned code hash and the code
// itself are secrets; they are never written to errors or logs by this package.
func (c *Client) SendCode(ctx context.Context, phone string) (SentCode, error) {
	sent, err := c.auth.SendCode(ctx, phone, auth.SendCodeOptions{})
	if err != nil && tgerr.Is(err, "AUTH_RESTART") {
		sent, err = c.auth.SendCode(ctx, phone, auth.SendCodeOptions{})
	}
	if err != nil {
		return SentCode{}, fmt.Errorf("telegramclient: send code: %w", err)
	}
	switch typed := sent.(type) {
	case *tg.AuthSentCode:
		_, viaApp := typed.Type.(*tg.AuthSentCodeTypeApp)
		return SentCode{
			PhoneCodeHash: typed.PhoneCodeHash,
			CodeViaApp:    viaApp,
		}, nil
	case *tg.AuthSentCodeSuccess:
		return SentCode{}, ErrAlreadyAuthorized
	default:
		return SentCode{}, fmt.Errorf("telegramclient: send code: unexpected auth.sentCode type %T", sent)
	}
}

// SignIn signs in with the SMS/app code. ErrPasswordNeeded is returned (wrapped)
// when the account is protected by 2FA; ErrSignUpRequired is returned when the
// phone number has no account. Telegram RPC errors keep their tgerr type so the
// HTTP layer can map them without text matching.
//
// Note the argument order: GramJS auth.signIn takes the code and the hash in
// that order; the gotd auth client takes (phone, code, codeHash), which this
// method hides.
func (c *Client) SignIn(ctx context.Context, phone, phoneCodeHash, code string) error {
	_, err := c.auth.SignIn(ctx, phone, code, phoneCodeHash)
	return normalizeAuthError(err)
}

// SignInWithPassword completes a 2FA login after SignIn returned
// ErrPasswordNeeded. The password is not trimmed (Telegram does not trim it) and
// is never logged.
func (c *Client) SignInWithPassword(ctx context.Context, password string) error {
	_, err := c.auth.Password(ctx, password)
	return normalizeAuthError(err)
}

// normalizeAuthError maps the gotd auth sentinels onto this package's exported
// errors while preserving the original error chain (so tgerr classification and
// ErrorDescription keep working through errors.Is/errors.As).
func normalizeAuthError(err error) error {
	if err == nil {
		return nil
	}
	var signUpRequired *auth.SignUpRequired
	if errors.As(err, &signUpRequired) {
		return fmt.Errorf("%w: %w", ErrSignUpRequired, err)
	}
	if errors.Is(err, auth.ErrPasswordAuthNeeded) {
		return fmt.Errorf("%w: %w", ErrPasswordNeeded, err)
	}
	return err
}
