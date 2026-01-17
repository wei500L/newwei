import { NARRATIVE_PATTERNS, SOURCE_TYPES, type NarrativePattern } from "./patterns";
import type { SituationNewsItem } from "./types";

export interface NarrativeData {
  id: string;
  name: string;
  category: string;
  severity: NarrativePattern["severity"];
  count: number;
  fringeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: SituationNewsItem[];
  keywords: string[];
}

export interface EmergingFringe extends NarrativeData {
  status: "emerging" | "spreading" | "viral";
}

export interface FringeToMainstream extends NarrativeData {
  status: "crossing";
  crossoverLevel: number;
}

export interface NarrativeResults {
  emergingFringe: EmergingFringe[];
  fringeToMainstream: FringeToMainstream[];
  narrativeWatch: NarrativeData[];
  disinfoSignals: NarrativeData[];
}

function formatNarrativeName(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function classifySource(source: string): "fringe" | "alternative" | "mainstream" | null {
  const lowerSource = source.toLowerCase();

  for (const fringeSource of SOURCE_TYPES.fringe) {
    if (lowerSource.includes(fringeSource)) return "fringe";
  }
  for (const altSource of SOURCE_TYPES.alternative) {
    if (lowerSource.includes(altSource)) return "alternative";
  }
  for (const msSource of SOURCE_TYPES.mainstream) {
    if (lowerSource.includes(msSource)) return "mainstream";
  }
  return null;
}

export function analyzeNarratives(allNews: SituationNewsItem[]): NarrativeResults | null {
  if (!allNews || allNews.length === 0) return null;

  const results: NarrativeResults = {
    emergingFringe: [],
    fringeToMainstream: [],
    narrativeWatch: [],
    disinfoSignals: [],
  };

  for (const narrative of NARRATIVE_PATTERNS) {
    const matches: SituationNewsItem[] = [];
    const sourceMatches: {
      fringe: SituationNewsItem[];
      alternative: SituationNewsItem[];
      mainstream: SituationNewsItem[];
    } = {
      fringe: [],
      alternative: [],
      mainstream: [],
    };

    for (const item of allNews) {
      const title = (item.title || "").toLowerCase();
      const source = (item.source || "").toLowerCase();

      const hasMatch = narrative.keywords.some((kw) => title.includes(kw.toLowerCase()));
      if (!hasMatch) {
        continue;
      }

      matches.push(item);

      const sourceType = classifySource(source);
      if (sourceType) {
        sourceMatches[sourceType].push(item);
      }
    }

    if (matches.length === 0) {
      continue;
    }

    const narrativeData: NarrativeData = {
      id: narrative.id,
      name: formatNarrativeName(narrative.id),
      category: narrative.category,
      severity: narrative.severity,
      count: matches.length,
      fringeCount: sourceMatches.fringe.length,
      mainstreamCount: sourceMatches.mainstream.length,
      sources: [...new Set(matches.map((m) => m.source))].slice(0, 5),
      headlines: matches.slice(0, 3),
      keywords: narrative.keywords,
    };

    if (sourceMatches.mainstream.length > 0 && sourceMatches.fringe.length > 0) {
      results.fringeToMainstream.push({
        ...narrativeData,
        status: "crossing",
        crossoverLevel: sourceMatches.mainstream.length / matches.length,
      });
    } else if (narrative.severity === "disinfo") {
      results.disinfoSignals.push(narrativeData);
    } else if (sourceMatches.fringe.length > 0 || sourceMatches.alternative.length > 0) {
      const status: EmergingFringe["status"] =
        matches.length >= 5 ? "viral" : matches.length >= 3 ? "spreading" : "emerging";

      results.emergingFringe.push({
        ...narrativeData,
        status,
      });
    } else {
      results.narrativeWatch.push(narrativeData);
    }
  }

  results.emergingFringe.sort((a, b) => b.count - a.count);
  results.fringeToMainstream.sort((a, b) => b.crossoverLevel - a.crossoverLevel);
  results.narrativeWatch.sort((a, b) => b.count - a.count);
  results.disinfoSignals.sort((a, b) => b.count - a.count);

  return results;
}

export function getNarrativeSummary(results: NarrativeResults | null): { total: number; status: string } {
  if (!results) {
    return { total: 0, status: "NO DATA" };
  }

  const total =
    results.emergingFringe.length +
    results.fringeToMainstream.length +
    results.narrativeWatch.length +
    results.disinfoSignals.length;

  return {
    total,
    status: total > 0 ? `${total} ACTIVE` : "MONITORING",
  };
}
