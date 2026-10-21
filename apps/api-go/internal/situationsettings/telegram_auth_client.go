package situationsettings

import (
	"context"
	"errors"
)

// This file is the narrow, telegramclient-decoupled login surface of a
// temporary MTProto client. cmd/api owns the adapter that maps
// internal/telegramclient (gotd) onto these types; the situationsettings
// package deliberately does not import internal/telegramclient so unit tests
// can inject fakes and the settings package stays free of the MTProto stack.
//
// The shape mirrors internal/telegramclient.Client:
//
//	SendCode(ctx, phone)         -> {PhoneCodeHash, CodeViaApp}
//	SignIn(ctx, phone, hash, code)
//	SignInWithPassword(ctx, password)
//	ExportStringSession()        -> GramJS 2.26.22 StringSession string
//	Close()

// ErrTelegramSignUpRequired reports that Telegram answered auth.signIn with
// auth.authorizationSignUpRequired, i.e. the phone number has no account yet.
// The cmd/api factory adapter maps gotd's *auth.AuthorizationSignUpRequired
// result onto this sentinel; completeAuth maps it to
// TELEGRAM_AUTH_SIGNUP_REQUIRED.
var ErrTelegramSignUpRequired = errors.New("situationsettings: telegram sign up required")

// ErrTelegramPasswordNeeded reports SESSION_PASSWORD_NEEDED, i.e. the account
// has two-step verification enabled. The cmd/api factory adapter maps gotd's
// auth.ErrPasswordAuthNeeded (and any equivalent RPC error) onto this
// sentinel; completeAuth then asks for the password or performs
// SignInWithPassword.
var ErrTelegramPasswordNeeded = errors.New("situationsettings: telegram password needed")

// TelegramSentCode is telegramclient.SentCode without the import: the phone
// code hash Telegram returned and whether the code was delivered in-app.
type TelegramSentCode struct {
	PhoneCodeHash string
	CodeViaApp    bool
}

// TelegramAuthClient is one already-connected temporary client. Close must be
// idempotent and is always called by the service, including on error paths
// (NestJS disconnectClient in a finally block).
type TelegramAuthClient interface {
	SendCode(ctx context.Context, phone string) (TelegramSentCode, error)
	SignIn(ctx context.Context, phone, phoneCodeHash, code string) error
	SignInWithPassword(ctx context.Context, password string) error
	ExportStringSession() (string, error)
	Close()
}

// TelegramAuthClientFactory starts a temporary client. An empty sessionString
// means a fresh unauthenticated session (startAuth); a pending session string
// resumes the login (completeAuth). The returned client is already connected
// (equivalent to `new TelegramClient(...)` followed by `await client.connect()`)
// so NewTemporary errors correspond to NestJS connect() failures and go
// through the same toBadRequest mapping.
type TelegramAuthClientFactory interface {
	NewTemporary(ctx context.Context, apiID int, apiHash, sessionString string) (TelegramAuthClient, error)
}
