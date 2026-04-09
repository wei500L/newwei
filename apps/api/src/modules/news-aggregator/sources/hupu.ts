import { myFetch } from "./fetch";
import { defineSource } from "./source";

interface HotItem {
  id: string
  title: string
  url: string
  mobileUrl: string
}

export default defineSource(async () => {
  // 获取虎扑新热榜页面的HTML内容
  const html = await myFetch(`https://bbs.hupu.com/topic-daily-hot`)

  // 正则表达式匹配新的热榜项结构
  const regex = /<li class="bbs-sl-web-post-body">[\s\S]*?<a href="(\/[^"]+?\.html)"[^>]*?class="p-title"[^>]*>([^<]+)<\/a>/g

  const result: HotItem[] = []
	
  for (const match of html.matchAll(regex)) {
    const path = match[1]
    const title = match[2]
    if (!path || !title) {
      continue
    }

    // 构建完整URL
    const url = `https://bbs.hupu.com${path}`

    result.push({
      id: path,
      title: title.trim(),
      url,
      mobileUrl: url,
    })
  }

  return result
})
