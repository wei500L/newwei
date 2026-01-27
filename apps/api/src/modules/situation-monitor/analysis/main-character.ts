import { PERSON_PATTERNS } from "./patterns";
import type { SituationNewsItem } from "./types";

export interface MainCharacterEntry {
  name: string;
  count: number;
  rank: number;
}

export interface MainCharacterResults {
  characters: MainCharacterEntry[];
  topCharacter: MainCharacterEntry | null;
}

export function calculateMainCharacter(allNews: SituationNewsItem[]): MainCharacterResults {
  if (!allNews || allNews.length === 0) {
    return { characters: [], topCharacter: null };
  }

  const counts: Record<string, number> = {};

  for (const item of allNews) {
    const text = (item.title || "").toLowerCase();

    for (const { pattern, name } of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) {
        counts[name] = (counts[name] || 0) + matches.length;
      }
    }
  }

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count], index) => ({
      name,
      count,
      rank: index + 1,
    }));

  return {
    characters: sorted,
    topCharacter: sorted[0] || null,
  };
}

export function getMainCharacterSummary(results: MainCharacterResults): {
  name: string;
  count: number;
  status: string;
  statusZh?: string;
} {
  if (!results.topCharacter) {
    return { name: "", count: 0, status: "NO DATA" };
  }

  const { name, count } = results.topCharacter;
  return {
    name,
    count,
    status: `${name} (${count} mentions)`,
  };
}
