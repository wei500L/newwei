package newsnowsources

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func setTransport(service *Service, fn roundTripFunc) {
	service.client.client.Transport = fn
}

func TestZhihuJSONFixture(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	setTransport(service, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/api/v3/feed/topstory/hot-list-web" {
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
		return httpJSON(`{"data":[{"target":{"title_area":{"text":"标题"},"excerpt_area":{"text":"摘要"},"metrics_area":{"text":"100 万热度"},"link":{"url":"https://www.zhihu.com/question/12345"}}}]}`, 200), nil
	})

	items, err := service.fetchZhihu(context.Background(), RuntimeContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID.Text != "12345" || items[0].Title != "标题" {
		t.Fatalf("unexpected items: %#v", items)
	}
	if items[0].Extra == nil || items[0].Extra.Info == nil || items[0].Extra.Info.Text != "100 万热度" {
		t.Fatalf("info missing: %#v", items[0].Extra)
	}
}

func TestIthomeHTMLFixtureFiltersAds(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	fixture := `<html><body><div id="list"><div class="fl"><ul>
<li><a class="t" href="https://www.ithome.com/0/1.htm">正常新闻</a><i>3分钟前</i></li>
<li><a class="t" href="https://www.ithome.com/0/2.htm">京东优惠</a><i>4分钟前</i></li>
<li><a class="t" href="https://www.ithome.com/lapin/3.htm">广告新闻</a><i>5分钟前</i></li>
</ul></div></div></body></html>`
	setTransport(service, func(*http.Request) (*http.Response, error) { return httpJSON(fixture, 200), nil })

	items, err := service.fetchIthome(context.Background(), RuntimeContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Title != "正常新闻" {
		t.Fatalf("ad filtering failed: %#v", items)
	}
	if items[0].PubDate == nil || items[0].PubDate.Kind != ValueNumber {
		t.Fatalf("relative date must become a timestamp: %#v", items[0].PubDate)
	}
}

func TestZaobaoGB2312Fixture(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	html := `<html><body><div class="list-block">
<a class="item" href="/realtime/1.html"><span class="eps">早报标题</span><span class="pdt10">2024-10-01 12:00</span></a>
</div></body></html>`
	encoded, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(html))
	if err != nil {
		t.Fatal(err)
	}
	setTransport(service, func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
	})

	items, err := service.fetchZaobao(context.Background(), RuntimeContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Title != "早报标题" {
		t.Fatalf("GB2312 decoding failed: %#v", items)
	}
	if items[0].PubDate == nil || items[0].PubDate.Kind != ValueString {
		t.Fatalf("unparsed absolute date must stay a string: %#v", items[0].PubDate)
	}
}

func TestPcbetaRSSFixture(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	fixture := `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>远景</title>
<item><title>帖子一</title><link>https://bbs.pcbeta.com/viewthread-1.html</link><guid>g1</guid><pubDate>Mon, 19 Oct 2026 10:00:00 +0800</pubDate><description>desc</description></item>
<item><title>帖子二</title><link>https://bbs.pcbeta.com/viewthread-2.html</link><guid>g2</guid><pubDate>Mon, 19 Oct 2026 11:00:00 +0800</pubDate></item>
</channel></rss>`
	setTransport(service, func(*http.Request) (*http.Response, error) { return httpJSON(fixture, 200), nil })

	items, err := service.fetchPcbetaWindows11(context.Background(), RuntimeContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Title != "帖子一" || items[0].ID.Text != "https://bbs.pcbeta.com/viewthread-1.html" {
		t.Fatalf("rss mapping failed: %#v", items)
	}
	if items[0].PubDate == nil || items[0].PubDate.Kind != ValueString {
		t.Fatalf("rss created date must keep its string shape: %#v", items[0].PubDate)
	}
}

func TestAtomFeedLinkHref(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	fixture := `<?xml version="1.0"?><feed><title>t</title>
<entry><title>atom</title><link href="https://example.com/a"/><id>i1</id><updated>2026-10-19T10:00:00Z</updated></entry>
</feed>`
	setTransport(service, func(*http.Request) (*http.Response, error) { return httpJSON(fixture, 200), nil })
	items, err := service.fetchChongbuluoLatest(context.Background(), RuntimeContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].URL != "https://example.com/a" {
		t.Fatalf("atom link href not used: %#v", items)
	}
}

func TestCLSQuerySignature(t *testing.T) {
	const want = "appName=CailianpressWeb&os=web&sv=7.7.5&sign=9c11221af4f6b47b253098a8b9957b8f"
	if got := clsQuery(); got != want {
		t.Fatalf("cls query = %q, want %q", got, want)
	}
}

func TestCoolapkTokenFixture(t *testing.T) {
	now := time.Unix(1700000000, 0)
	counter := 0
	random := func(length int) string {
		switch counter {
		case 0:
			counter++
			return strings.Repeat("a", length)
		case 1:
			counter++
			return strings.Repeat("b", length)
		case 2:
			counter++
			return strings.Repeat("c", length)
		case 3:
			counter++
			return strings.Repeat("d", length)
		default:
			counter++
			return strings.Repeat("e", length)
		}
	}
	headers := coolapkHeaders(now, random)
	want := "d197f538bfa3d9ebba11b45ce3b92782aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee0x6553f100"
	if headers["X-App-Token"] != want {
		t.Fatalf("token=%q, want %q", headers["X-App-Token"], want)
	}
	if headers["X-App-Version"] != "11.0" {
		t.Fatalf("unexpected headers: %#v", headers)
	}
}

func TestWeiboSecretRequiredAndEnvFallback(t *testing.T) {
	store := newFakeStore()
	service := newTestService(fakeRegistry{"weibo": {ID: "weibo", Interval: 120000}}, &fakeSecrets{}, store)
	service.getters["weibo"] = service.fetchWeibo

	if _, err := service.FetchSource(context.Background(), "weibo", false); err == nil {
		t.Fatal("missing cookie must fail")
	} else if typed, ok := err.(*APIError); !ok || typed.Status != http.StatusFailedDependency || typed.Code != CodeRuntimeSecretRequired {
		t.Fatalf("unexpected error: %#v", err)
	}

	service.env = func(key string) string {
		if key == "WEIBO_COOKIE" {
			return "env-cookie"
		}
		return ""
	}
	fixture := `<html><body><div id="pl_top_realtimehot"><table><tbody>
<tr><td>header</td></tr>
<tr><td class="td-02"><a href="/weibo?q=1">热搜一</a></td><td class="td-03">热</td></tr>
</tbody></table></div></body></html>`
	var cookieHeader string
	setTransport(service, func(request *http.Request) (*http.Response, error) {
		cookieHeader = request.Header.Get("Cookie")
		return httpJSON(fixture, 200), nil
	})
	items, err := service.fetchWeibo(context.Background(), RuntimeContext{SourceID: "weibo", RequestedSourceID: "weibo"})
	if err != nil {
		t.Fatal(err)
	}
	if cookieHeader != "env-cookie" {
		t.Fatalf("env fallback not used: %q", cookieHeader)
	}
	if len(items) != 1 || items[0].ID.Text != "热搜一" {
		t.Fatalf("unexpected items: %#v", items)
	}
	if items[0].Extra == nil || items[0].Extra.Icon == nil || items[0].Extra.Icon.Shape != IconObject {
		t.Fatalf("weibo flag icon must be an object: %#v", items[0].Extra)
	}
}

func TestWeiboRuntimeSecretWinsOverEnv(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	service.env = func(string) string { return "env-cookie" }
	fixture := `<html><body></body></html>`
	var cookieHeader string
	setTransport(service, func(request *http.Request) (*http.Response, error) {
		cookieHeader = request.Header.Get("Cookie")
		return httpJSON(fixture, 200), nil
	})
	_, err := service.fetchWeibo(context.Background(), RuntimeContext{
		SourceID:          "weibo",
		RequestedSourceID: "weibo",
		Secrets:           map[string]string{"weibo_cookie": "  runtime-cookie  "},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cookieHeader != "runtime-cookie" {
		t.Fatalf("runtime secret must override env, got %q", cookieHeader)
	}
}

func TestProductHuntTokenAliasAndBearer(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	var authorization string
	var body string
	setTransport(service, func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		raw, _ := io.ReadAll(request.Body)
		body = string(raw)
		return httpJSON(`{"data":{"posts":{"edges":[{"node":{"id":"p1","name":"PH","tagline":"tag","votesCount":0,"url":"https://ph/p1","slug":"ph"}}]}}}`, 200), nil
	})
	items, err := service.fetchProductHunt(context.Background(), RuntimeContext{
		SourceID:          "producthunt",
		RequestedSourceID: "producthunt",
		Secrets:           map[string]string{"producthunt.token": "Bearer abc"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer abc" {
		t.Fatalf("bearer prefix must be normalised, got %q", authorization)
	}
	if !strings.Contains(body, "posts(first: 30, order: VOTES)") {
		t.Fatalf("unexpected graphql body: %s", body)
	}
	if len(items) != 1 || items[0].Extra.Info.Text != " △︎ 0" {
		t.Fatalf("unexpected product hunt mapping: %#v", items)
	}
}

func TestFreebufMergeDedupesAndSorts(t *testing.T) {
	older := newItem(StringID("1"), "older", "https://example.com/a").pubDate(Millis(1000)).build()
	newer := newItem(StringID("2"), "newer", "https://example.com/b").pubDate(Millis(2000)).build()
	duplicate := newItem(StringID("3"), "dup", "https://example.com/a ").pubDate(Millis(3000)).build()
	merged := mergeAndSortFreebuf([]NewsItem{older, newer, duplicate})
	if len(merged) != 2 {
		t.Fatalf("dedupe failed: %#v", merged)
	}
	if merged[0].ID.Text != "2" {
		t.Fatalf("sorting failed: %#v", merged)
	}
}
