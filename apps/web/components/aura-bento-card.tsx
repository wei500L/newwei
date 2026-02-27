'use client';

import React from 'react';
import { useCardGlow } from '../hooks/use-card-glow';

interface AuraBentoCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  squish?: boolean;
}

export function AuraBentoCard({ children, className = '', squish = true, ...props }: AuraBentoCardProps) {
  const { ref, style, onMouseMove } = useCardGlow();

  const squishClass = squish 
    ? 'active:scale-[0.98] active:brightness-105 active:backdrop-blur-[20px] transition-all duration-150 ease-spring' 
    : '';

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      className={`glass-card relative overflow-hidden group ${squishClass} ${className}`}
      style={style}
      {...props}
    >
      <div 
        className="pointer-events-none absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: 'radial-gradient(circle at var(--glow-x, 50%) var(--glow-y, 50%), rgba(255,255,255,0.1) 0%, transparent 60%)',
        }}
      />
      <div className="relative z-10 h-full w-full">
        {children}
      </div>
    </div>
  );
}
