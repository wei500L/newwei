'use client';

import { usePathname } from 'next/navigation';

export function AuraBackground() {
  const pathname = usePathname();
  const isReadMode = pathname.includes('/read/') || pathname.match(/\/items\/\w+/);
  const isFinance = pathname.includes('/finance');
  const isTechLike =
    pathname.includes('/tech') ||
    pathname.includes('/dashboard') ||
    pathname.includes('/situation-monitor');

  const colors = isFinance
    ? {
        color1: 'rgba(245, 158, 11, 0.2)',
        color2: 'rgba(217, 119, 6, 0.16)',
        color3: 'rgba(252, 211, 77, 0.12)',
      }
    : isTechLike
      ? {
          color1: 'rgba(59, 130, 246, 0.16)',
          color2: 'rgba(139, 92, 246, 0.12)',
          color3: 'rgba(56, 189, 248, 0.1)',
        }
      : {
          color1: 'var(--aura-color-1)',
          color2: 'var(--aura-color-2)',
          color3: 'rgba(255, 255, 255, 0.06)',
        };

  if (isReadMode) {
    return null; // Don't render background for pure reading pages
  }

  return (
    <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
      <div
        className="absolute top-[-20%] left-[-10%] h-[62%] w-[62%] rounded-full mix-blend-normal opacity-70 blur-[110px] animate-aura-breathe motion-reduce:animate-none dark:opacity-95"
        style={{
          background: `radial-gradient(circle at 52% 48%, ${colors.color1} 0%, transparent 70%)`,
          transition: 'background 700ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform, opacity',
        }}
      />
      <div
        className="absolute bottom-[-12%] right-[-12%] h-[54%] w-[54%] rounded-full mix-blend-normal opacity-65 blur-[115px] animate-aura-drift motion-reduce:animate-none dark:opacity-90"
        style={{
          background: `radial-gradient(circle at 48% 52%, ${colors.color2} 0%, transparent 72%)`,
          animationDelay: '-7s',
          transition: 'background 700ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform, opacity',
        }}
      />
      <div
        className="absolute left-[31%] top-[4%] hidden h-[34%] w-[38%] rounded-full mix-blend-screen opacity-50 blur-[96px] animate-aura-shimmer motion-reduce:animate-none sm:block dark:opacity-75"
        style={{
          background: `radial-gradient(circle at 50% 45%, ${colors.color3} 0%, transparent 72%)`,
          animationDelay: '-3.5s',
          transition: 'background 700ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform, opacity',
        }}
      />
    </div>
  );
}
