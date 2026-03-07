import { myFetch } from "./fetch";
import { defineSource } from "./source";

import process from "node:process"
import { NewsSourceRuntimeSecretRequiredError } from "../news-aggregator.errors"
import { PRODUCTHUNT_RUNTIME_SECRETS_CONFIG } from '../news-source-runtime-secrets.catalog'
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
  const runtimeToken = resolveRuntimeSecret(
    context?.secrets,
    PRODUCTHUNT_RUNTIME_SECRETS_CONFIG.suggestedKeys ?? [],
  )
  const apiToken = runtimeToken || process.env.PRODUCTHUNT_API_TOKEN
  if (!apiToken) {
    throw new NewsSourceRuntimeSecretRequiredError({
      sourceId: context?.requestedSourceId ?? context?.sourceId ?? "producthunt",
      requiredKeys: PRODUCTHUNT_RUNTIME_SECRETS_CONFIG.requiredAnyOfKeys ?? [],
      message:
        "Product Hunt API token is required; configure a runtime secret or PRODUCTHUNT_API_TOKEN",
    })
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
