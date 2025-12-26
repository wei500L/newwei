"use client";

import { Avatar } from "antd";
import type { AvatarProps } from "antd";
import { useEffect, useMemo, useState } from "react";

const getInitials = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    return parts[0]?.slice(0, 2).toUpperCase() ?? "";
  }
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
};

const DefaultAvatarIcon = () => (
  <svg
    viewBox="0 0 64 64"
    aria-hidden="true"
    focusable="false"
    width="1em"
    height="1em"
  >
    <circle cx="32" cy="24" r="14" fill="currentColor" opacity="0.7" />
    <path
      d="M8 56c0-12.15 10.75-22 24-22s24 9.85 24 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="8"
      strokeLinecap="round"
      opacity="0.7"
    />
  </svg>
);

export interface AvatarFallbackProps {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: AvatarProps["size"];
  className?: string;
}

export function AvatarFallback({ src, name, email, size, className }: AvatarFallbackProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [src]);

  const label = useMemo(() => {
    return [name, email].filter(Boolean).join(" ").trim();
  }, [name, email]);
  const initials = useMemo(() => getInitials(label), [label]);
  const showImage = Boolean(src) && !imageFailed;
  const showInitials = !showImage && Boolean(initials);

  return (
    <Avatar
      size={size}
      className={className}
      src={
        showImage ? (
          <img
            src={src ?? undefined}
            alt={label || "avatar"}
            onError={() => setImageFailed(true)}
            referrerPolicy="no-referrer"
          />
        ) : undefined
      }
      icon={!showImage && !showInitials ? <DefaultAvatarIcon /> : undefined}
    >
      {showInitials ? initials : undefined}
    </Avatar>
  );
}
