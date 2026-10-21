package telegramclient

import (
	"context"
	"errors"
	"fmt"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Message is one polled Telegram channel message.
type Message struct {
	// ID is the message id inside the channel.
	ID int
	// DateUnix is the message date in unix seconds (message.date).
	DateUnix int64
	// Text is the raw message text; empty for media-only messages.
	Text string
}

// FetchHistory returns up to limit channel messages newer than minID, newest
// first, exactly like GramJS getMessages(entity, {limit, minId}):
//
//   - the RPC is messages.getHistory with OffsetID/OffsetDate/MaxID/MinID zero,
//     which is what GramJS sends (it filters ids client-side);
//   - messages with id <= minID are dropped, so a cursor never moves backwards;
//   - service messages and empty messages are skipped;
//   - the server order (id descending) is preserved; the caller sorts by date.
//
// Unlike GramJS, a manually built request may send MinID directly; the client
// filter is kept because gotd passes MinID=minID only when set, and keeping the
// request identical to GramJS makes the RPC cache behaviour identical too.
//
// When Telegram reports a stale entity (CHANNEL_INVALID, CHANNEL_PRIVATE,
// USERNAME_NOT_OCCUPIED, PEER_ID_INVALID), the cached channel peer is deleted
// and resolved again once, then the history request is retried. This mirrors
// NestJS re-resolving the entity on every poll and keeps the access hash fresh.
func (c *Client) FetchHistory(ctx context.Context, peer Peer, limit, minID int) ([]Message, error) {
	if peer.ChannelID == 0 {
		return nil, errors.New("telegramclient: fetch history: channel id is empty")
	}
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("telegramclient: fetch history: limit %d is outside 1..100", limit)
	}
	if minID < 0 {
		minID = 0
	}

	messages, err := c.fetchHistory(ctx, peer, limit, minID)
	if err == nil {
		return messages, nil
	}
	if !isStalePeerError(err) {
		return nil, err
	}

	handle, ok := c.channelHandle(peer.ChannelID)
	if !ok {
		// The peer was not resolved by this client, so there is no handle to
		// refresh. Report the original Telegram error to the caller.
		return nil, err
	}
	c.deleteCachedPeer(ctx, handle)
	refreshed, resolveErr := c.resolveChannelHandle(ctx, handle)
	if resolveErr != nil {
		return nil, fmt.Errorf("telegramclient: refresh channel %q after %s: %w", handle, ErrorDescription(err), resolveErr)
	}
	c.storeCachedPeer(ctx, handle, refreshed)
	c.rememberChannelHandle(refreshed.ChannelID, handle)
	return c.fetchHistory(ctx, refreshed, limit, minID)
}

// fetchHistory performs one messages.getHistory round trip.
func (c *Client) fetchHistory(ctx context.Context, peer Peer, limit, minID int) ([]Message, error) {
	response, err := c.api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
		Peer:  &tg.InputPeerChannel{ChannelID: peer.ChannelID, AccessHash: peer.AccessHash},
		Limit: limit,
	})
	if err != nil {
		return nil, fmt.Errorf("telegramclient: get history: %w", err)
	}

	var raw []tg.MessageClass
	switch typed := response.(type) {
	case *tg.MessagesChannelMessages:
		raw = typed.Messages
	case *tg.MessagesMessages:
		raw = typed.Messages
	case *tg.MessagesMessagesSlice:
		raw = typed.Messages
	case *tg.MessagesMessagesNotModified:
		// Hash is always zero, so this should not happen; an empty page is safe.
		return nil, nil
	case nil:
		return nil, errors.New("telegramclient: get history: empty response")
	default:
		return nil, fmt.Errorf("telegramclient: get history: unexpected response %T", response)
	}

	messages := make([]Message, 0, len(raw))
	for _, item := range raw {
		// Only regular messages carry a date and text; MessageService (joins,
		// title changes) and MessageEmpty are skipped, matching GramJS/Nest.
		message, ok := item.(*tg.Message)
		if !ok {
			continue
		}
		if message.ID <= minID {
			continue
		}
		messages = append(messages, Message{
			ID:       message.ID,
			DateUnix: int64(message.Date),
			Text:     message.Message,
		})
	}
	return messages, nil
}

// isStalePeerError reports whether a history error means the cached channel id
// or access hash must be refreshed before retrying.
func isStalePeerError(err error) bool {
	return tgerr.Is(err,
		"CHANNEL_INVALID",
		"CHANNEL_PRIVATE",
		"USERNAME_NOT_OCCUPIED",
		"PEER_ID_INVALID",
	)
}
