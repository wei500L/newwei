import { myFetch } from "./fetch"
import freebufSource from "./freebuf"
import { rss2json } from "./rss2json"

jest.mock("./fetch", () => ({
  myFetch: jest.fn(),
}))

jest.mock("./rss2json", () => ({
  rss2json: jest.fn(),
}))

describe("freebuf source", () => {
  const mockedMyFetch = myFetch as unknown as jest.Mock
  const mockedRss2json = rss2json as unknown as jest.Mock

  beforeEach(() => {
    mockedMyFetch.mockReset()
    mockedRss2json.mockReset()
  })

  it("requests rsshub freebuf routes with web/system type and returns merged items", async () => {
    mockedMyFetch
      .mockResolvedValueOnce({
        items: [
          {
            id: "w1",
            title: "Web 1",
            url: "https://www.freebuf.com/articles/web/1.html",
            date_published: "2026-03-01T10:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "s1",
            title: "System 1",
            url: "https://www.freebuf.com/articles/system/2.html",
            date_published: "2026-03-01T11:00:00.000Z",
          },
        ],
      })

    const items = await freebufSource()

    expect(mockedMyFetch).toHaveBeenCalledTimes(2)
    expect(mockedMyFetch.mock.calls[0][0]).toContain("/freebuf/articles/web")
    expect(mockedMyFetch.mock.calls[1][0]).toContain("/freebuf/articles/system")
    expect(items.map(item => item.url)).toEqual([
      "https://www.freebuf.com/articles/system/2.html",
      "https://www.freebuf.com/articles/web/1.html",
    ])
  })

  it("falls back to secondary rsshub instance when primary fails", async () => {
    mockedMyFetch
      .mockRejectedValueOnce(new Error("primary web failed"))
      .mockRejectedValueOnce(new Error("primary system failed"))
      .mockResolvedValueOnce({
        items: [
          {
            id: "w2",
            title: "Web 2",
            url: "https://www.freebuf.com/articles/web/22.html",
            date_published: "2026-03-01T12:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] })

    const items = await freebufSource()

    expect(mockedMyFetch).toHaveBeenCalledTimes(4)
    expect(items).toHaveLength(1)
    expect(items[0]?.url).toBe("https://www.freebuf.com/articles/web/22.html")
    expect(mockedRss2json).not.toHaveBeenCalled()
  })

  it("falls back to native feed when all rsshub requests fail", async () => {
    mockedMyFetch
      .mockRejectedValueOnce(new Error("p-web failed"))
      .mockRejectedValueOnce(new Error("p-system failed"))
      .mockRejectedValueOnce(new Error("s-web failed"))
      .mockRejectedValueOnce(new Error("s-system failed"))

    mockedRss2json.mockResolvedValue({
      items: [
        {
          title: "Feed Web",
          link: "https://www.freebuf.com/articles/web/9.html",
          created: "2026-03-01T08:00:00.000Z",
          description: "feed-web",
        },
        {
          title: "Feed Other",
          link: "https://www.freebuf.com/articles/other/10.html",
          created: "2026-03-01T07:00:00.000Z",
          description: "feed-other",
        },
      ],
    })

    const items = await freebufSource()

    expect(mockedRss2json).toHaveBeenCalledWith("https://www.freebuf.com/feed")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      url: "https://www.freebuf.com/articles/web/9.html",
      extra: {
        hover: "feed-web",
      },
    })
  })

  it("returns empty array when all strategies fail", async () => {
    mockedMyFetch
      .mockRejectedValueOnce(new Error("p-web failed"))
      .mockRejectedValueOnce(new Error("p-system failed"))
      .mockRejectedValueOnce(new Error("s-web failed"))
      .mockRejectedValueOnce(new Error("s-system failed"))
    mockedRss2json.mockRejectedValueOnce(new Error("feed failed"))

    await expect(freebufSource()).resolves.toEqual([])
  })
})
