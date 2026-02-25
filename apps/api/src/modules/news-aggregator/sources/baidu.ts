import { myFetch } from "./fetch";
import { defineSource } from "./source";

interface Res {
  data: {
    cards: {
      content: {
        isTop?: boolean
        word: string
        rawUrl: string
        desc?: string
      }[]
    }[]
  }
}

export default defineSource(async () => {
  const rawData: string = await myFetch(`https://top.baidu.com/board?tab=realtime`)
  const jsonStr = (rawData as string).match(/<!--s-data:(.*?)-->/s)
  const payload = jsonStr?.[1]
  if (!payload) {
    return []
  }
  const data: Res = JSON.parse(payload)
  const firstCard = data.data.cards[0]
  if (!firstCard?.content) {
    return []
  }

  return firstCard.content.filter(k => !k.isTop).map((k) => {
    return {
      id: k.rawUrl,
      title: k.word,
      url: k.rawUrl,
      extra: {
        hover: k.desc,
      },
    }
  })
})
