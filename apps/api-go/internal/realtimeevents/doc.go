// Package realtimeevents owns the event sources for the Go realtime Socket.IO
// transport (the /newsnow, /ops, /quality, /queue and /situation-monitor
// namespaces served by internal/realtimesocket on /socket.io-realtime).
//
// One event class has exactly one delivery path:
//
//   - newsnow: the events come from the Socket.IO Redis adapter broadcast
//     channel (produced by the NestJS gateway/dispatcher) and from the
//     newsnow:source-refresh:v1 relay published by the Go fetch unit. Both are
//     translated into local pushes; the refresh path additionally re-publishes
//     an adapter broadcast so every instance in a mixed deployment observes the
//     event exactly once.
//   - situation-monitor: the events come from the situation-monitor:signals:v1
//     event bridge published by the NestJS dispatcher, are augmented per
//     organization for the users connected to this process, and are pushed
//     locally.
//   - queue, ops and quality: the events come from the BullMQ event streams
//     (bull:<queue>:events). Every process reads the full stream from "$" (no
//     consumer group, no ACK) and pushes only to its own connections (B1). The
//     three namespaces are the only consumers of those streams here; the
//     Socket.IO adapter channels for them are never subscribed.
//
// Every push goes through the Sink interface, which realtimesocket.Runtime
// implements as a strictly local operation: no Redis adapter publish is issued
// for a local push. The only adapter publish in this package is the newsnow
// refresh fanout, which is encoded by hand to stay byte-compatible with
// @socket.io/redis-adapter 8.3.0 (see adapter.go).
package realtimeevents
