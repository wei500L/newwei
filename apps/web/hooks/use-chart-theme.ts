"use client";

import { useEffect, useState } from "react";
import { theme } from "antd";

export interface ChartTheme {
  echartsTheme: string;
  colors: {
    primary: string;
    bullish: string;
    bearish: string;
    accent: string;
    background: string;
    foreground: string;
    border: string;
    grid: string;
    tooltipBg: string;
    tooltipText: string;
    secondary: string;
  };
  fontFamily: string;
}

const DEFAULT_THEME: ChartTheme = {
  echartsTheme: "smart-light",
  colors: {
    primary: "#1f3b7b",
    bullish: "#1b9e77",
    bearish: "#d95f02",
    accent: "#d97706",
    background: "transparent",
    foreground: "#475569",
    border: "#e2e8f0",
    grid: "rgba(15, 23, 42, 0.08)",
    tooltipBg: "#0f172a",
    tooltipText: "#f8fafc",
    secondary: "#e2e8f0"
  },
  fontFamily: "var(--font-mono), monospace",
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
      echartsTheme: "smart-light",
      colors: {
        primary: getVar("--primary", "#1f3b7b"),
        bullish: getVar("--bullish", "#1b9e77"),
        bearish: getVar("--bearish", "#d95f02"),
        accent: getVar("--accent", "#d97706"),
        background: "transparent",
        foreground: getVar("--foreground", "#475569"),
        border: getVar("--border", "#e2e8f0"),
        grid: "rgba(15, 23, 42, 0.08)",
        tooltipBg: "#0f172a",
        tooltipText: "#f8fafc",
        secondary: getVar("--secondary", "#e2e8f0")
      },
      fontFamily: "var(--font-mono), monospace",
    });
  }, [token]);

  return chartTheme;
}
