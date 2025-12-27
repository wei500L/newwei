"use client";

import { useEffect, useState } from "react";
import { theme } from "antd";

export interface ChartTheme {
  colors: {
    bullish: string;
    bearish: string;
    accent: string;
    background: string;
    foreground: string;
    grid: string;
    tooltipBg: string;
    tooltipText: string;
  };
  fontFamily: string;
}

const DEFAULT_THEME: ChartTheme = {
  colors: {
    bullish: "#10b981",
    bearish: "#f43f5e",
    accent: "#ffab00",
    background: "transparent",
    foreground: "#94a3b8", // Slate 400
    grid: "rgba(255, 255, 255, 0.05)",
    tooltipBg: "rgba(15, 23, 42, 0.9)", // Slate 900
    tooltipText: "#e2e8f0",
  },
  fontFamily: "var(--font-roboto-mono), monospace",
};

export function useChartTheme(): ChartTheme {
  const { token } = theme.useToken();
  const [chartTheme, setChartTheme] = useState<ChartTheme>(DEFAULT_THEME);

  useEffect(() => {
    // Helper to get CSS variable value
    const getVar = (name: string, fallback: string) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };

    setChartTheme({
      colors: {
        bullish: getVar("--bullish", "#10b981"),
        bearish: getVar("--bearish", "#f43f5e"),
        accent: getVar("--accent", "#ffab00"),
        background: "transparent",
        foreground: getVar("--foreground", "#94a3b8"),
        grid: "rgba(255, 255, 255, 0.05)",
        tooltipBg: "#1e293b", // Slate 800
        tooltipText: "#f8fafc", // Slate 50
      },
      fontFamily: "var(--font-roboto-mono), monospace",
    });
  }, [token]); // Re-run if AntD theme changes, though mainly dependent on CSS vars

  return chartTheme;
}