import { myFetch } from "./fetch";
import { defineSource } from "./source";

import type { NewsItem } from "../news-aggregator.types"

export default defineSource(async () => {
  const html: string = await myFetch("https://www.ifeng.com/")
  const regex = /var\s+allData\s*=\s*(\{[\s\S]*?\});/
  const match = regex.exec(html)
  const news: NewsItem[] = []
  if (match) {
    const payload = match[1]
    if (!payload) {
      return news
    }
    const realData = JSON.parse(payload)
    const rawNews = realData.hotNews1 as {
      url: string
      title: string
      newsTime: string
    }[]
    rawNews.forEach((hotNews) => {
      news.push({
        id: hotNews.url,
        url: hotNews.url,
        title: hotNews.title,
        extra: {
          date: hotNews.newsTime,
        },
      })
    })
  }
  return news
})
