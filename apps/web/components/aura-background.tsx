'use client';

import { usePathname } from 'next/navigation';

import { PAPER_BACKGROUND_GRADIENT } from '@/lib/aura-theme-tokens';

export function AuraBackground() {
  const pathname = usePathname();
  const isReadMode = pathname.includes('/read/') || pathname.match(/\/items\/\w+/);
  if (isReadMode) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{ background: PAPER_BACKGROUND_GRADIENT }}
    />
  );
}
