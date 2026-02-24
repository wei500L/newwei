import { myFetch } from "./fetch";
import { defineSource } from "./source";

import process from "node:process"
import type { NewsItem } from "../news-aggregator.types"

function resolveRuntimeSecret(secrets: Record<string, string> | undefined, keys: string[]) {
  if (!secrets) {
    return undefined
  }
  for (const key of keys) {
    const value = secrets[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function stripBearerPrefix(value: string) {
  return value.replace(/^bearer\s+/i, "").trim()
}

export default defineSource(async (context) => {
  const runtimeToken = resolveRuntimeSecret(context?.secrets, [
    "token",
    "api_token",
    "producthunt.api_token",
    "producthunt.token",
  ])
  const apiToken = runtimeToken || process.env.PRODUCTHUNT_API_TOKEN
  if (!apiToken) {
    throw new Error("PRODUCTHUNT_API_TOKEN is not set")
  }
  const token = `Bearer ${stripBearerPrefix(apiToken)}`
  const query = `
    query {
      posts(first: 30, order: VOTES) {
        edges {
          node {
            id
            name
            tagline
            votesCount
            url
            slug
          }
        }
      }
    }
  `

  const response: any = await myFetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      "Authorization": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query }),
  })

  const news: NewsItem[] = []
  const posts = response?.data?.posts?.edges || []

  for (const edge of posts) {
    const post = edge.node
    if (post.id && post.name) {
      news.push({
        id: post.id,
        title: post.name,
        url: post.url || `https://www.producthunt.com/posts/${post.slug}`,
        extra: {
          info: ` △︎ ${post.votesCount || 0}`,
          hover: post.tagline,
        },
      })
    }
  }

  return news
})
