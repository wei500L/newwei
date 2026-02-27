'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export function AuraBackground() {
  const pathname = usePathname();
  const [colors, setColors] = useState({
    color1: 'var(--aura-color-1)',
    color2: 'var(--aura-color-2)',
  });

  useEffect(() => {
    // Dynamic switching logic (can be expanded)
    if (pathname.includes('/finance')) {
      setColors({
        color1: 'rgba(217, 119, 6, 0.15)', // Amber/Gold
        color2: 'rgba(245, 158, 11, 0.1)',
      });
    } else if (pathname.includes('/tech') || pathname.includes('/dashboard') || pathname.includes('/situation-monitor')) {
      setColors({
        color1: 'rgba(59, 130, 246, 0.15)', // Blue/Purple
        color2: 'rgba(139, 92, 246, 0.1)',
      });
    } else if (pathname.includes('/read/') || pathname.match(/\/items\/\w+/)) {
      // Pure reading mode, disable aura
      setColors({
        color1: 'transparent',
        color2: 'transparent',
      });
    } else {
      setColors({
        color1: 'var(--aura-color-1)',
        color2: 'var(--aura-color-2)',
      });
    }
  }, [pathname]);

  if (pathname.includes('/read/') || pathname.match(/\/items\/\w+/)) {
    return null; // Don't render background for pure reading pages
  }

  return (
    <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
      <div 
        className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full mix-blend-normal filter blur-[100px] animate-aura-breathe opacity-70 dark:opacity-100"
        style={{
          background: `radial-gradient(circle, ${colors.color1} 0%, transparent 70%)`,
          willChange: 'transform',
        }}
      />
      <div 
        className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full mix-blend-normal filter blur-[100px] animate-aura-breathe opacity-70 dark:opacity-100"
        style={{
          background: `radial-gradient(circle, ${colors.color2} 0%, transparent 70%)`,
          animationDelay: '-5s',
          willChange: 'transform',
        }}
      />
    </div>
  );
}
