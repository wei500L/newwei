// Package gotdprobe is a temporary dependency-bootstrap package.
//
// The api-go module fetches its dependency manifest only through the
// go-modules-regen CI channel: developers may not run the Go toolchain locally
// and must not hand-write go.sum. This package blank-imports every gotd/td
// package the Telegram migration is expected to use, so the first
// go-modules-regen run can resolve and commit the complete module graph before
// the real implementation files exist. It is deleted once the implementation
// imports the same set; the final go-modules-regen pass prunes anything unused.
package gotdprobe

import (
	_ "github.com/gotd/td/bin"
	_ "github.com/gotd/td/crypto"
	_ "github.com/gotd/td/telegram"
	_ "github.com/gotd/td/telegram/auth"
	_ "github.com/gotd/td/telegram/session"
	_ "github.com/gotd/td/tg"
	_ "github.com/gotd/td/tgerr"
	_ "github.com/gotd/td/tgtest"
)
