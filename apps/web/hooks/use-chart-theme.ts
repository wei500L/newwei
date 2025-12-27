import { useEffect, useState } from "react";
import { theme } from "antd";

// Mapping from semantic names to Tailwind CSS variables
const TAILWIND_VARS = {
  primary: "--primary",
  secondary: "--secondary",
  accent: "--accent",
  destructive: "--destructive",
  bullish: "--bullish",
  bearish: "--bearish",
  background: "--background",
  foreground: "--foreground",
  border: "--border",
} as const;

type ThemeColors = Record<keyof typeof TAILWIND_VARS, string>;

export function useChartTheme() {
  const { token } = theme.useToken();
  const [colors, setColors] = useState<ThemeColors | null>(null);

  useEffect(() => {
    // Function to read CSS variable
    const getVar = (name: string) => {
      if (typeof window === "undefined") return "";
      return getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    };

    // Initialize with current values
    const newColors = Object.entries(TAILWIND_VARS).reduce((acc, [key, varName]) => {
      acc[key as keyof ThemeColors] = getVar(varName);
      return acc;
    }, {} as ThemeColors);

    setColors(newColors);
  }, []); // Empty dependency array means this runs once on mount. 
          // If theme changes dynamically without reload, we might need to listen to changes,
          // but usually CSS vars updates are handled by CSS. 
          // However, for JS-side consumption, we might need a trigger.
          // For now, assuming static theme or reload on theme change.

  return {
    colors,
    echartsTheme: colors ? {
      color: [
        colors.primary,
        colors.secondary,
        colors.accent,
        colors.bullish,
        colors.bearish,
        "#fac858",
        "#ee6666",
        "#73c0de",
        "#3ba272",
        "#fc8452",
        "#9a60b4",
        "#ea7ccc"
      ],
      backgroundColor: "transparent",
      tooltip: {
        backgroundColor: colors.background,
        borderColor: colors.border,
        textStyle: {
          color: colors.foreground,
        },
      },
      title: {
        textStyle: {
          color: colors.foreground,
        },
      },
      textStyle: {
        color: colors.foreground,
      },
      legend: {
        textStyle: {
          color: colors.foreground,
        },
      },
      categoryAxis: {
        axisLine: {
          lineStyle: {
            color: colors.border,
          },
        },
        axisLabel: {
          color: colors.foreground,
        },
      },
      valueAxis: {
        splitLine: {
          lineStyle: {
            color: colors.border,
          },
        },
        axisLabel: {
          color: colors.foreground,
        },
      },
    } : undefined
  };
}
