'use client';

import { useState, useRef, MouseEvent } from 'react';

export function useCardGlow() {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState({});

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setStyle({
      '--glow-x': `${x}px`,
      '--glow-y': `${y}px`,
    });
  };

  return {
    ref,
    style,
    onMouseMove: handleMouseMove,
  };
}
