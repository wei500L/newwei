package telegramclient

import (
	"context"
	"errors"
	"testing"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

func TestFetchHistoryFiltersAndPreservesOrder(t *testing.T) {
	api := &fakeTelegramAPI{historyFn: func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		return &tg.MessagesChannelMessages{Messages: []tg.MessageClass{
			&tg.Message{ID: 10, Date: 1000, Message: "newest"},
			&tg.Message{ID: 9, Date: 900, Message: "media-only"},
			&tg.MessageService{ID: 8, Date: 800},
			&tg.Message{ID: 7, Date: 700, Message: "at cursor"},
			&tg.Message{ID: 6, Date: 600, Message: "before cursor"},
			&tg.MessageEmpty{ID: 5},
		}}, nil
	}}
	client := newPollTestClient(t, api, nil)

	messages, err := client.FetchHistory(context.Background(), Peer{ChannelID: 1, AccessHash: 2}, 10, 7)
	if err != nil {
		t.Fatalf("FetchHistory() error = %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("FetchHistory() returned %d messages, want 2: %+v", len(messages), messages)
	}
	if messages[0] != (Message{ID: 10, DateUnix: 1000, Text: "newest"}) {
		t.Errorf("messages[0] = %+v", messages[0])
	}
	if messages[1] != (Message{ID: 9, DateUnix: 900, Text: "media-only"}) {
		t.Errorf("messages[1] = %+v", messages[1])
	}

	request := api.historyRequest(0)
	peer, ok := request.Peer.(*tg.InputPeerChannel)
	if !ok {
		t.Fatalf("request peer = %T, want *tg.InputPeerChannel", request.Peer)
	}
	if peer.ChannelID != 1 || peer.AccessHash != 2 {
		t.Errorf("request peer = %+v", peer)
	}
	if request.Limit != 10 {
		t.Errorf("request limit = %d, want 10", request.Limit)
	}
	// Mirrors GramJS getMessages: only limit is set, ids are filtered locally.
	if request.OffsetID != 0 || request.OffsetDate != 0 || request.AddOffset != 0 || request.MaxID != 0 || request.MinID != 0 || request.Hash != 0 {
		t.Errorf("request offsets = %+v, want all zero", request)
	}
}

func TestFetchHistoryResponseShapes(t *testing.T) {
	tests := []struct {
		name     string
		response tg.MessagesMessagesClass
		wantIDs  []int
	}{
		{
			name:     "messages",
			response: &tg.MessagesMessages{Messages: []tg.MessageClass{&tg.Message{ID: 2}, &tg.Message{ID: 1}}},
			wantIDs:  []int{2, 1},
		},
		{
			name:     "slice",
			response: &tg.MessagesMessagesSlice{Messages: []tg.MessageClass{&tg.Message{ID: 4}}},
			wantIDs:  []int{4},
		},
		{
			name:     "not modified",
			response: &tg.MessagesMessagesNotModified{Count: 3},
			wantIDs:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeTelegramAPI{historyFn: func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
				return tt.response, nil
			}}
			client := newPollTestClient(t, api, nil)
			messages, err := client.FetchHistory(context.Background(), Peer{ChannelID: 1, AccessHash: 2}, 10, 0)
			if err != nil {
				t.Fatalf("FetchHistory() error = %v", err)
			}
			if len(messages) != len(tt.wantIDs) {
				t.Fatalf("FetchHistory() = %+v, want %d messages", messages, len(tt.wantIDs))
			}
			for i, wantID := range tt.wantIDs {
				if messages[i].ID != wantID {
					t.Errorf("messages[%d].ID = %d, want %d", i, messages[i].ID, wantID)
				}
			}
		})
	}
}

func TestFetchHistoryRetriesStalePeerOnce(t *testing.T) {
	api := &fakeTelegramAPI{
		resolveFn: resolveToChannel(200, 300),
	}
	var calls int
	api.historyFn = func(_ context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		calls++
		peer := request.Peer.(*tg.InputPeerChannel)
		if calls == 1 {
			if peer.ChannelID != 200 || peer.AccessHash != 999 {
				t.Errorf("first request peer = %+v, want stale {200 999}", peer)
			}
			return nil, tgerr.New(400, "CHANNEL_INVALID")
		}
		if peer.ChannelID != 200 || peer.AccessHash != 300 {
			t.Errorf("retry request peer = %+v, want refreshed {200 300}", peer)
		}
		return &tg.MessagesChannelMessages{Messages: []tg.MessageClass{
			&tg.Message{ID: 5, Date: 50, Message: "after refresh"},
		}}, nil
	}
	cache := newFakePeerCache()
	client := newPollTestClient(t, api, cache)

	// Prime the resolve side the way the worker does: ResolveChannel then
	// FetchHistory with the returned peer.
	stalePeer, err := client.ResolveChannel(context.Background(), "channel")
	if err != nil {
		t.Fatalf("ResolveChannel() error = %v", err)
	}
	if stalePeer.ChannelID != 200 {
		t.Fatalf("primed peer = %+v", stalePeer)
	}
	// Simulate the cached access hash going stale: the fake first history call
	// reports CHANNEL_INVALID for the old pair.

	// The fake resolve returns the same channel (200/300); the retry must use it.
	messages, err := client.FetchHistory(context.Background(), Peer{ChannelID: 200, AccessHash: 999}, 10, 0)
	if err != nil {
		t.Fatalf("FetchHistory() error = %v", err)
	}
	if len(messages) != 1 || messages[0].Text != "after refresh" {
		t.Fatalf("FetchHistory() = %+v", messages)
	}
	if calls != 2 {
		t.Errorf("history calls = %d, want 2 (one retry)", calls)
	}
	if api.resolveCount() != 2 {
		t.Errorf("resolve calls = %d, want 2 (initial + refresh)", api.resolveCount())
	}
	raw, ok := cache.raw(PeerCacheKeyPrefix + "channel")
	if !ok {
		t.Fatal("cache entry missing after refresh")
	}
	wantStored := []byte(`{"channelId":200,"accessHash":300}`)
	if string(raw) != string(wantStored) {
		t.Errorf("cache after refresh = %s, want %s", raw, wantStored)
	}
}

func TestFetchHistoryStalePeerWithoutResolvedHandle(t *testing.T) {
	api := &fakeTelegramAPI{historyFn: func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		return nil, tgerr.New(400, "CHANNEL_INVALID")
	}}
	client := newPollTestClient(t, api, newFakePeerCache())

	_, err := client.FetchHistory(context.Background(), Peer{ChannelID: 1, AccessHash: 2}, 10, 0)
	if !IsChannelInvalid(err) {
		t.Errorf("FetchHistory() error = %v, want CHANNEL_INVALID", err)
	}
	if api.historyCount() != 1 {
		t.Errorf("history calls = %d, want 1 (no handle to refresh)", api.historyCount())
	}
}

func TestFetchHistoryDoesNotRetryOtherErrors(t *testing.T) {
	api := &fakeTelegramAPI{historyFn: func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		return nil, tgerr.New(420, "FLOOD_WAIT_9")
	}}
	client := newPollTestClient(t, api, newFakePeerCache())

	_, err := client.FetchHistory(context.Background(), Peer{ChannelID: 1, AccessHash: 2}, 10, 0)
	if !IsFloodWait(err) {
		t.Errorf("FetchHistory() error = %v, want FLOOD_WAIT", err)
	}
	if api.historyCount() != 1 {
		t.Errorf("history calls = %d, want 1", api.historyCount())
	}
}

func TestFetchHistoryValidation(t *testing.T) {
	api := &fakeTelegramAPI{}
	client := newPollTestClient(t, api, nil)

	for _, tc := range []struct {
		name  string
		peer  Peer
		limit int
		minID int
	}{
		{name: "zero channel", peer: Peer{}, limit: 10},
		{name: "zero limit", peer: Peer{ChannelID: 1}, limit: 0},
		{name: "limit too large", peer: Peer{ChannelID: 1}, limit: 101},
	} {
		if _, err := client.FetchHistory(context.Background(), tc.peer, tc.limit, tc.minID); err == nil {
			t.Errorf("%s: FetchHistory() error = nil, want error", tc.name)
		}
	}
	if api.historyCount() != 0 {
		t.Errorf("history calls = %d, want 0", api.historyCount())
	}
}

func TestIsStalePeerError(t *testing.T) {
	for _, err := range []error{
		tgerr.New(400, "CHANNEL_INVALID"),
		tgerr.New(400, "CHANNEL_PRIVATE"),
		tgerr.New(400, "USERNAME_NOT_OCCUPIED"),
		tgerr.New(400, "PEER_ID_INVALID"),
	} {
		if !isStalePeerError(err) {
			t.Errorf("isStalePeerError(%v) = false, want true", err)
		}
	}
	if isStalePeerError(tgerr.New(420, "FLOOD_WAIT_2")) {
		t.Error("isStalePeerError(FLOOD_WAIT) = true, want false")
	}
	if isStalePeerError(errors.New("network")) {
		t.Error("isStalePeerError(plain) = true, want false")
	}
}
