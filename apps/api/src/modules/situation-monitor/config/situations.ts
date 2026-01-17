export interface SituationPanelConfig {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  subtitle: string;
  matchKeywords: string[];
  criticalKeywords: string[];
}

export const SITUATION_PANELS: SituationPanelConfig[] = [
  {
    id: "venezuela",
    title: "Venezuela Watch",
    subtitle: "Humanitarian crisis monitoring",
    criticalKeywords: ["maduro", "caracas", "venezuela", "guaido"],
    matchKeywords: ["venezuela", "maduro"],
  },
  {
    id: "greenland",
    title: "Greenland Watch",
    subtitle: "Arctic geopolitics monitoring",
    criticalKeywords: ["greenland", "arctic", "nuuk", "denmark"],
    matchKeywords: ["greenland", "arctic"],
  },
  {
    id: "iran",
    title: "Iran Crisis",
    subtitle: "Revolution protests, regime instability & nuclear program",
    criticalKeywords: [
      "protest",
      "uprising",
      "revolution",
      "crackdown",
      "killed",
      "nuclear",
      "strike",
      "attack",
      "irgc",
      "khamenei",
    ],
    matchKeywords: ["iran", "tehran", "irgc"],
  },
];

