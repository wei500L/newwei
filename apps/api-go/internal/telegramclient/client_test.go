package telegramclient

import (
	"bytes"
	"context"
	"errors"
	"net"
	"runtime"
	"strings"
	"testing"

	"github.com/gotd/td/crypto"
	"github.com/gotd/td/session"
)

func TestNewValidation(t *testing.T) {
	validKey := fixtureAuthKey(t)
	validSession := Session{DC: 2, Address: "149.154.167.51", Port: 443, AuthKey: validKey}

	tests := []struct {
		name string
		opts Options
	}{
		{name: "no api id", opts: Options{APIHash: "hash"}},
		{name: "negative api id", opts: Options{APIID: -1, APIHash: "hash"}},
		{name: "blank api hash", opts: Options{APIID: 1, APIHash: "   "}},
		{name: "session without dc", opts: Options{APIID: 1, APIHash: "hash", Session: Session{Address: "a", Port: 443, AuthKey: validKey}}},
		{name: "session dc too large", opts: Options{APIID: 1, APIHash: "hash", Session: Session{DC: 256, Address: "a", Port: 443, AuthKey: validKey}}},
		{name: "session without address", opts: Options{APIID: 1, APIHash: "hash", Session: Session{DC: 2, Port: 443, AuthKey: validKey}}},
		{name: "session without port", opts: Options{APIID: 1, APIHash: "hash", Session: Session{DC: 2, Address: "a", AuthKey: validKey}}},
		{name: "session with short key", opts: Options{APIID: 1, APIHash: "hash", Session: Session{DC: 2, Address: "a", Port: 443, AuthKey: validKey[:32]}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := New(tt.opts); err == nil {
				t.Error("New() error = nil, want error")
			}
		})
	}

	if _, err := New(Options{APIID: 1, APIHash: "hash", Session: validSession}); err != nil {
		t.Errorf("New(valid session) error = %v", err)
	}
	if _, err := New(Options{APIID: 1, APIHash: "hash"}); err != nil {
		t.Errorf("New(temporary client) error = %v", err)
	}
}

func TestExportSessionFromImportedSession(t *testing.T) {
	imported, err := DecodeStringSession(ipv6TextSessionString)
	if err != nil {
		t.Fatalf("DecodeStringSession() error = %v", err)
	}
	client, err := New(Options{APIID: 1, APIHash: "hash", Session: imported})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	exported, err := client.ExportSession()
	if err != nil {
		t.Fatalf("ExportSession() error = %v", err)
	}
	if exported.DC != imported.DC {
		t.Errorf("exported DC = %d, want %d", exported.DC, imported.DC)
	}
	if exported.Port != 443 {
		t.Errorf("exported port = %d, want 443", exported.Port)
	}
	if !bytes.Equal(exported.AuthKey, imported.AuthKey) {
		t.Error("exported auth key differs from the imported one")
	}
	// gotd never stores the address, so it is derived from the DC options. It
	// must still be a real IPv4 address for the same DC.
	if net.ParseIP(exported.Address) == nil || strings.Contains(exported.Address, ":") {
		t.Errorf("exported address = %q, want an IPv4 DC address", exported.Address)
	}

	// The exported GramJS string must decode again.
	encoded, err := client.ExportStringSession()
	if err != nil {
		t.Fatalf("ExportStringSession() error = %v", err)
	}
	roundTripped, err := DecodeStringSession(encoded)
	if err != nil {
		t.Fatalf("DecodeStringSession(exported) error = %v", err)
	}
	if roundTripped.DC != exported.DC || roundTripped.Address != exported.Address || roundTripped.Port != exported.Port || !bytes.Equal(roundTripped.AuthKey, exported.AuthKey) {
		t.Errorf("round-tripped session = %+v, want %+v", roundTripped, exported)
	}

	// Export hands out a copy: mutating it must not corrupt the storage.
	exported.AuthKey[0] ^= 0xff
	again, err := client.ExportSession()
	if err != nil {
		t.Fatalf("ExportSession() second call error = %v", err)
	}
	if bytes.Equal(again.AuthKey, exported.AuthKey) {
		t.Error("ExportSession() returned an aliased auth key slice")
	}
}

func TestExportSessionWithoutSession(t *testing.T) {
	client, err := New(Options{APIID: 1, APIHash: "hash"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := client.ExportSession(); !errors.Is(err, ErrNoSession) {
		t.Errorf("ExportSession() error = %v, want ErrNoSession", err)
	}
	if _, err := client.ExportStringSession(); !errors.Is(err, ErrNoSession) {
		t.Errorf("ExportStringSession() error = %v, want ErrNoSession", err)
	}
}

func TestSessionDataFrom(t *testing.T) {
	authKey := fixtureAuthKey(t)
	data := sessionDataFrom(Session{DC: 2, Address: "149.154.167.51", Port: 443, AuthKey: authKey})

	if data.DC != 2 {
		t.Errorf("DC = %d, want 2", data.DC)
	}
	if data.Addr != "149.154.167.51:443" {
		t.Errorf("Addr = %q", data.Addr)
	}
	if data.Salt != 0 {
		t.Errorf("Salt = %d, want 0", data.Salt)
	}
	if !bytes.Equal(data.AuthKey, authKey) {
		t.Error("AuthKey was not copied verbatim")
	}
	var key crypto.Key
	copy(key[:], authKey)
	wantID := key.ID()
	if !bytes.Equal(data.AuthKeyID, wantID[:]) {
		t.Errorf("AuthKeyID = %x, want %x", data.AuthKeyID, wantID)
	}
}

func TestMemoryStorage(t *testing.T) {
	storage := &memoryStorage{}
	if _, err := storage.LoadSession(context.Background()); !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("LoadSession() error = %v, want session.ErrNotFound", err)
	}

	data := &session.Data{DC: 2, AuthKey: make([]byte, AuthKeySize), AuthKeyID: make([]byte, 8)}
	if err := storage.saveData(context.Background(), data); err != nil {
		t.Fatalf("saveData() error = %v", err)
	}
	loaded, err := storage.loadData(context.Background())
	if err != nil {
		t.Fatalf("loadData() error = %v", err)
	}
	if loaded.DC != 2 {
		t.Errorf("loaded DC = %d, want 2", loaded.DC)
	}

	// StoreSession copies the input so gotd cannot mutate the stored state.
	raw := []byte(`{"Version":1,"Data":{"DC":5}}`)
	if err := storage.StoreSession(context.Background(), raw); err != nil {
		t.Fatalf("StoreSession() error = %v", err)
	}
	raw[0] = 'X'
	stored, err := storage.LoadSession(context.Background())
	if err != nil {
		t.Fatalf("LoadSession() error = %v", err)
	}
	if stored[0] != '{' {
		t.Error("StoreSession() did not copy the input buffer")
	}
}

func TestDeviceConfigDefaults(t *testing.T) {
	config := deviceConfig(Device{})
	if config.AppVersion != gramJSAppVersion {
		t.Errorf("AppVersion = %q, want %q", config.AppVersion, gramJSAppVersion)
	}
	if config.LangCode != gramJSLangCode {
		t.Errorf("LangCode = %q, want %q", config.LangCode, gramJSLangCode)
	}
	if config.SystemLangCode != gramJSLangCode {
		t.Errorf("SystemLangCode = %q, want %q", config.SystemLangCode, gramJSLangCode)
	}
	if config.DeviceModel == "" || config.DeviceModel == "n/a" {
		t.Errorf("DeviceModel = %q, want a runtime-derived value", config.DeviceModel)
	}
	if config.SystemVersion == "" || config.SystemVersion == "n/a" {
		t.Errorf("SystemVersion = %q, want a runtime-derived value", config.SystemVersion)
	}
	if runtime.GOOS == "linux" && config.DeviceModel != "Linux" {
		t.Errorf("DeviceModel on linux = %q, want Linux (Node os.type())", config.DeviceModel)
	}
}

func TestDeviceConfigExplicit(t *testing.T) {
	config := deviceConfig(Device{
		Model:         "Samsung Galaxy S23",
		SystemVersion: "SDK 33",
		AppVersion:    "10.0.0",
		LangCode:      "de",
	})
	if config.DeviceModel != "Samsung Galaxy S23" || config.SystemVersion != "SDK 33" || config.AppVersion != "10.0.0" || config.LangCode != "de" {
		t.Errorf("explicit device config was not preserved: %+v", config)
	}
	if config.SystemLangCode != gramJSLangCode {
		t.Errorf("SystemLangCode = %q, want %q", config.SystemLangCode, gramJSLangCode)
	}
}

func TestClientCloseIsTerminalAndIdempotent(t *testing.T) {
	client, err := New(Options{APIID: 1, APIHash: "hash"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	client.Close()
	client.Close() // idempotent, never started so it must not block.

	if err := client.Start(context.Background()); !errors.Is(err, ErrClientClosed) {
		t.Errorf("Start() after Close error = %v, want ErrClientClosed", err)
	}
	if err := client.Run(context.Background()); !errors.Is(err, ErrClientClosed) {
		t.Errorf("Run() after Close error = %v, want ErrClientClosed", err)
	}
	if client.API() == nil {
		t.Error("API() = nil")
	}
}
