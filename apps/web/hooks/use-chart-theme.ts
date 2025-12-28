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
    bullish: "#00ff9d", // Neon Green
    bearish: "#ff0055", // Neon Red
    accent: "#ffb700", // Amber
    background: "transparent",
    foreground: "#94a3b8", // Slate 400
    grid: "rgba(0, 240, 255, 0.05)", // Subtle Cyan Grid
    tooltipBg: "rgba(3, 7, 18, 0.95)", // Gray 950
    tooltipText: "#f8fafc", // Slate 50
  },
  fontFamily: "var(--font-roboto-mono), monospace",
};

export function useChartTheme(): ChartTheme {
  const { token } = theme.useToken();
  const [chartTheme, setChartTheme] = useState<ChartTheme>(DEFAULT_THEME);

  useEffect(() => {
    // Helper to get CSS variable value
    const getVar = (name: string, fallback: string) => {
      if (typeof window === 'undefined') return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };

    setChartTheme({
      colors: {
        bullish: getVar("--bullish", "#00ff9d"),
        bearish: getVar("--bearish", "#ff0055"),
        accent: getVar("--accent", "#ffb700"),
        background: "transparent",
        foreground: getVar("--foreground", "#94a3b8"),
        grid: "rgba(0, 240, 255, 0.05)",
        tooltipBg: "rgba(3, 7, 18, 0.95)",
        tooltipText: "#f8fafc",
      },
      fontFamily: "var(--font-roboto-mono), monospace",
    });
  }, [token]);

  return chartTheme;
}