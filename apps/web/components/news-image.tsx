"use client";

import { FileImageOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";

type NewsImageAspectRatio = "video" | "fourThree" | "square" | "cinema";
type NewsImageFallback = "gradient" | "initials" | "icon";

const ASPECT_RATIO_CLASS: Record<NewsImageAspectRatio, string> = {
  video: "aspect-video",
  fourThree: "aspect-[4/3]",
  square: "aspect-square",
  cinema: "aspect-[21/9]"
};

export interface NewsImageProps {
  src?: string | null;
  alt: string;
  aspectRatio?: NewsImageAspectRatio;
  fallback?: NewsImageFallback;
  fallbackText?: string;
  className?: string;
  imgClassName?: string;
  priority?: boolean;
  showSkeleton?: boolean;
}

function resolveInitial(value?: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  return normalized.charAt(0).toUpperCase();
}

export function NewsImage({
  src,
  alt,
  aspectRatio = "video",
  fallback = "gradient",
  fallbackText,
  className,
  imgClassName,
  priority = false,
  showSkeleton = true
}: NewsImageProps) {
  const normalizedSrc = typeof src === "string" && src.trim().length > 0 ? src : null;
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
    setHasError(false);
  }, [normalizedSrc]);

  const shouldRenderImage = Boolean(normalizedSrc && !hasError);
  const shouldShowSkeleton = Boolean(showSkeleton && shouldRenderImage && !isLoaded);
  const fallbackInitial = resolveInitial(fallbackText);
  const wrapperClassName = `${ASPECT_RATIO_CLASS[aspectRatio]} relative w-full overflow-hidden rounded-lg ${
    className ?? ""
  }`.trim();
  const imageClassName = `absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
    isLoaded ? "opacity-100" : "opacity-0"
  } ${imgClassName ?? ""}`.trim();

  return (
    <div className={wrapperClassName}>
      {fallback === "gradient" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-muted">
          {fallbackInitial ? (
            <span className="font-serif text-2xl text-muted-foreground">{fallbackInitial}</span>
          ) : (
            <FileImageOutlined className="text-base text-muted-foreground" />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-muted text-muted-foreground">
          {fallback === "initials" && fallbackInitial ? (
            <span className="font-serif text-2xl text-muted-foreground">{fallbackInitial}</span>
          ) : (
            <FileImageOutlined className="text-base" />
          )}
        </div>
      )}

      {shouldRenderImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={normalizedSrc ?? undefined}
          alt={alt}
          className={imageClassName}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          onLoad={() => setIsLoaded(true)}
          onError={() => {
            setHasError(true);
            setIsLoaded(false);
          }}
        />
      ) : null}

      {shouldShowSkeleton ? <div className="absolute inset-0 animate-pulse bg-white/45 dark:bg-black/35" /> : null}
    </div>
  );
}
