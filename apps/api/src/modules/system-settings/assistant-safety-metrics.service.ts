import { AssistantRunModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";

export interface AssistantSafetyDailyMetricsRow {
  date: string;
  totalRuns: number;
  blockedRuns: number;
  blockedRate: number;
  guardrails: { name: string; count: number }[];
  codes: { code: string; count: number }[];
}

@Injectable()
export class AssistantSafetyMetricsService {
  async getDailyMetrics(orgId: string, days: number): Promise<AssistantSafetyDailyMetricsRow[]> {
    const windowDays = Math.max(1, Math.min(90, Math.floor(days)));
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - (windowDays - 1));

    const dateExpr = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };

    const [result] = await AssistantRunModel.aggregate([
      { $match: { orgId, createdAt: { $gte: start } } },
      { $addFields: { date: dateExpr } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: "$date",
                totalRuns: { $sum: 1 },
                blockedRuns: { $sum: { $cond: [{ $eq: ["$output.blocked", true] }, 1, 0] } }
              }
            },
            { $sort: { _id: 1 } }
          ],
          guardrails: [
            { $match: { "output.blocked": true } },
            { $match: { "output.appliedGuardrails": { $type: "array" } } },
            { $addFields: { date: dateExpr } },
            { $unwind: "$output.appliedGuardrails" },
            {
              $group: {
                _id: { date: "$date", name: "$output.appliedGuardrails" },
                count: { $sum: 1 }
              }
            },
            {
              $group: {
                _id: "$_id.date",
                guardrails: { $push: { name: "$_id.name", count: "$count" } }
              }
            },
            { $sort: { _id: 1 } }
          ],
          codes: [
            { $match: { "output.blocked": true } },
            { $match: { "output.code": { $type: "string" } } },
            { $addFields: { date: dateExpr } },
            {
              $group: {
                _id: { date: "$date", code: "$output.code" },
                count: { $sum: 1 }
              }
            },
            {
              $group: {
                _id: "$_id.date",
                codes: { $push: { code: "$_id.code", count: "$count" } }
              }
            },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ]);

    const totals = Array.isArray(result?.totals) ? result.totals : [];
    const guardrails = Array.isArray(result?.guardrails) ? result.guardrails : [];
    const codes = Array.isArray(result?.codes) ? result.codes : [];

    const guardrailsMap = new Map<string, { name: string; count: number }[]>();
    for (const row of guardrails) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const date = typeof record._id === "string" ? record._id : String(record._id ?? "");
      const entriesRaw = record.guardrails;
      const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
      guardrailsMap.set(
        date,
        entries
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => ({
            name: typeof entry.name === "string" ? entry.name : "",
            count: typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0
          }))
          .filter((entry) => entry.name.length > 0)
      );
    }

    const codesMap = new Map<string, { code: string; count: number }[]>();
    for (const row of codes) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const date = typeof record._id === "string" ? record._id : String(record._id ?? "");
      const entriesRaw = record.codes;
      const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
      codesMap.set(
        date,
        entries
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => ({
            code: typeof entry.code === "string" ? entry.code : "",
            count: typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0
          }))
          .filter((entry) => entry.code.length > 0)
      );
    }

    const totalsMap = new Map<string, { totalRuns: number; blockedRuns: number }>();
    for (const row of totals) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const date = typeof record._id === "string" ? record._id : String(record._id ?? "");
      const totalRuns = typeof record.totalRuns === "number" ? record.totalRuns : Number(record.totalRuns ?? 0);
      const blockedRuns = typeof record.blockedRuns === "number" ? record.blockedRuns : Number(record.blockedRuns ?? 0);
      totalsMap.set(date, {
        totalRuns: Number.isFinite(totalRuns) ? totalRuns : 0,
        blockedRuns: Number.isFinite(blockedRuns) ? blockedRuns : 0
      });
    }

    const out: AssistantSafetyDailyMetricsRow[] = [];
    for (let offset = 0; offset < windowDays; offset += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + offset);
      const key = date.toISOString().slice(0, 10);
      const counts = totalsMap.get(key) ?? { totalRuns: 0, blockedRuns: 0 };
      const blockedRate = counts.totalRuns > 0 ? counts.blockedRuns / counts.totalRuns : 0;
      out.push({
        date: key,
        totalRuns: counts.totalRuns,
        blockedRuns: counts.blockedRuns,
        blockedRate,
        guardrails: guardrailsMap.get(key) ?? [],
        codes: codesMap.get(key) ?? []
      });
    }

    return out;
  }
}
