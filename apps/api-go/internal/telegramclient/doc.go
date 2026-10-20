// Package telegramclient is the Go Telegram MTProto client used by the
// situation-monitor signals worker and the Telegram auth endpoints.
//
// It replaces the GramJS 2.26.22 usage in
// apps/api/src/modules/situation-monitor/signals with github.com/gotd/td and
// keeps the persisted contracts byte-compatible:
//
//   - Session strings. Sessions stored in the situationsettings row are GramJS
//     StringSession values. DecodeStringSession and EncodeStringSession read
//     and write exactly the same layout (version character, standard base64,
//     dcId/address/port/auth key) including the legacy Telethon and raw-IPv6
//     shapes, so an existing configuration keeps working and a session produced
//     by this package can be loaded by NestJS if the feature flag is rolled
//     back.
//
//   - Peer resolution cache (O1). ResolveChannel resolves a channel handle to
//     its channel id and access hash and caches the pair in Redis for 24 hours
//     under situation-monitor:signals:telegram:peer:<handle> as JSON
//     {"channelId":<int64>,"accessHash":<int64>}. GramJS resolved the entity on
//     every poll; the cache removes that round trip, and FetchHistory deletes
//     and re-resolves the entry once when Telegram reports CHANNEL_INVALID,
//     USERNAME_NOT_OCCUPIED, CHANNEL_PRIVATE or PEER_ID_INVALID. The cache is
//     injected by NewManager into the long-lived clients (it is the only
//     production path); a bare Client built with New runs without a cache.
//
//   - Long-lived connection (O2). Run blocks with one MTProto connection that
//     gotd reconnects internally; Start starts the same connection in the
//     background (its lifetime is bound to Close, not to the Start context) and
//     returns once the first connection is ready. Polling and resolving reuse
//     this connection instead of reconnecting per cycle like GramJS did. gotd
//     multiplexes concurrent RPCs safely, but every call blocks while the client
//     reconnects, so callers must pass deadlines.
//
//   - Single-instance lease (B1). Manager holds the Redis lease
//     DefaultLeaseKey and only the lease owner creates an MTProto connection,
//     so two api-go processes can never poll the same session concurrently.
//     The lease is long-lived (renewed in the background) and is only released
//     by Disconnect (settings were cleared or new credentials were written) or
//     Close (shutdown). This is a deliberate correctness trade-off: with N
//     api-go replicas the cluster-level repeat job still fires on every
//     interval, but only the lease owner runs it, so the effective polling
//     interval grows with N. That is preferred over two processes sharing one
//     session, which risk AUTH_KEY_DUPLICATED and overwrite each other's Redis
//     cursor state; the worker treats owned=false as "another replica is
//     healthy" instead of an error.
//
// Error classification helpers (IsAuthKeyDuplicated, IsFloodWait,
// IsUsernameNotOccupied, IsChannelInvalid, FloodWaitSeconds) work on the
// gotd/td request error type rather than the error text, because the worker
// must keep the NestJS behaviour (stop polling on AUTH_KEY_DUPLICATED, stop the
// cycle early on FLOOD_WAIT, retry the peer cache on a stale entity) without
// relying on English messages.
//
// # Secrets
//
// Session strings, API hashes, login codes and passwords are secrets. No
// function in this package writes them to logs, errors or Redis; error values
// describe the failure class and the Telegram error type only.
package telegramclient
