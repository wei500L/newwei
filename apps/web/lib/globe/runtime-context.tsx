"use client";

import { createContext, useContext, type PropsWithChildren } from "react";

import type { GlobeRuntime } from "./runtime";

const GlobeRuntimeContext = createContext<GlobeRuntime | null>(null);

export function GlobeRuntimeProvider({
  runtime,
  children,
}: PropsWithChildren<{ runtime: GlobeRuntime }>) {
  return (
    <GlobeRuntimeContext.Provider value={runtime}>
      {children}
    </GlobeRuntimeContext.Provider>
  );
}

/** 取得当前页面的 GEV 运行时；必须在 <GlobeRuntimeProvider> 内使用。 */
export function useGlobeRuntime(): GlobeRuntime {
  const runtime = useContext(GlobeRuntimeContext);
  if (!runtime) {
    throw new Error("useGlobeRuntime must be used inside <GlobeRuntimeProvider>");
  }
  return runtime;
}
