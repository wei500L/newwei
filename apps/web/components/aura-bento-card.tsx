'use client';

import React from 'react';

interface AuraBentoCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  squish?: boolean;
}

export function AuraBentoCard({ children, className = '', squish = false, ...props }: AuraBentoCardProps) {
  const squishClass = squish ? 'transition-transform duration-150 active:scale-[0.99]' : '';
  return (
    <div className={`glass-card relative overflow-hidden ${squishClass} ${className}`} {...props}>
      <div className="relative h-full w-full">{children}</div>
    </div>
  );
}
