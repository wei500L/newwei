"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { useRenderableContainer } from "@/lib/map/use-renderable-container";

export interface WarMapWrapperSize {
  width: number;
  height: number;
}

export interface UseWarMapContainerResult {
  /** 外层容器（IntersectionObserver / ResizeObserver 的观察目标）。 */
  wrapperRef: RefObject<HTMLDivElement | null>;
  /** 地图挂载容器（renderable 判定目标）。 */
  mapContainerRef: RefObject<HTMLDivElement | null>;
  /** 地图是否进入视口（rootMargin 160px 预激活）。 */
  inView: boolean;
  /** 外层容器尺寸（overlay 密度布局输入）。 */
  wrapperSize: WarMapWrapperSize;
  /** 地图容器是否有可渲染尺寸（0×0 时不创建地图）。 */
  hasRenderableMapContainer: boolean;
}

/**
 * War Map 的容器观测域（FE-批4A）。
 *
 * 单一所有者职责：wrapper 的 inView（IntersectionObserver，160px 提前
 * 激活）与尺寸（ResizeObserver，尺寸不变时保持引用稳定），以及地图
 * 容器的 renderable 门禁（useRenderableContainer）。地图实例的创建
 * 与销毁由 use-war-map-runtime 依据这些输入执行。
 */
export function useWarMapContainer(): UseWarMapContainerResult {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [wrapperSize, setWrapperSize] = useState<WarMapWrapperSize>({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setInView(Boolean(entries[0]?.isIntersecting));
      },
      { rootMargin: "160px" },
    );

    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    const updateSize = () => {
      const nextWidth = root.clientWidth;
      const nextHeight = root.clientHeight;
      setWrapperSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    };

    updateSize();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const hasRenderableMapContainer = useRenderableContainer(
    mapContainerRef,
    inView,
  );

  return {
    wrapperRef,
    mapContainerRef,
    inView,
    wrapperSize,
    hasRenderableMapContainer,
  };
}
