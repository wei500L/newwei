
import * as cheerio from "cheerio"
import iconv from "iconv-lite"
import { Buffer } from "node:buffer"

import type { NewsItem } from "../news-aggregator.types"

import { parseRelativeDate } from "./date";
import { myFetch } from "./fetch";
import { defineSource } from "./source";

export default defineSource(async () => {
  const response: ArrayBuffer = await myFetch("https://www.zaochenbao.com/realtime/", {
    responseType: "arrayBuffer",
  })
  const base = "https://www.zaochenbao.com"
  const utf8String = iconv.decode(Buffer.from(response), "gb2312")
  const $ = cheerio.load(utf8String)
  const $main = $("div.list-block>a.item")
  const news: NewsItem[] = []
  $main.each((_, el) => {
    const a = $(el)
    const url = a.attr("href")
    const title = a.find(".eps")?.text()
    const date = a.find(".pdt10")?.text().replace(/-\s/g, " ")
    if (url && title && date) {
      news.push({
        url: base + url,
        title,
        id: url,
        pubDate: parseRelativeDate(date, "Asia/Shanghai").valueOf(),
      })
    }
  })
  return news.sort((m, n) => n.pubDate! > m.pubDate! ? 1 : -1)
})
