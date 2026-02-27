export function EmptyDigestSvg() {
  return (
    <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" className="w-full h-full max-w-[300px] mx-auto">
      <defs>
        {/* Soft shadow filter */}
        <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#1F3B7B" floodOpacity="0.04" />
          <feDropShadow dx="0" dy="12" stdDeviation="24" floodColor="#1F3B7B" floodOpacity="0.06" />
        </filter>
        
        {/* Aura Blur filter */}
        <filter id="aura-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="30" result="blur" />
        </filter>

        {/* Glass Gradient */}
        <linearGradient id="glass-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.1" />
        </linearGradient>

        {/* Edge Highlight */}
        <linearGradient id="edge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.8" />
          <stop offset="100%" stopColor="rgba(148,163,184,0.1)" />
        </linearGradient>
      </defs>

      {/* Aura Layer (Bottom) */}
      <g className="aura-glow-element">
        <circle cx="150" cy="120" r="60" fill="#3B82F6" opacity="0.25" filter="url(#aura-blur)" />
        <circle cx="260" cy="180" r="70" fill="#6366F1" opacity="0.2" filter="url(#aura-blur)" />
        <circle cx="210" cy="100" r="50" fill="#0EA5E9" opacity="0.15" filter="url(#aura-blur)" />
      </g>

      {/* Glass Material Layer (Middle) */}
      <g filter="url(#soft-shadow)" transform="translate(110, 80)">
        <rect width="180" height="140" rx="14" fill="url(#glass-gradient)" stroke="url(#edge-gradient)" strokeWidth="1.5" />
        
        {/* Floating inner elements (Bento grid style) */}
        <rect x="20" y="20" width="80" height="40" rx="8" fill="url(#glass-gradient)" stroke="url(#edge-gradient)" strokeWidth="1" opacity="0.8" />
        <rect x="30" y="32" width="40" height="4" rx="2" fill="#1F2933" opacity="0.2" />
        <rect x="30" y="44" width="60" height="4" rx="2" fill="#1F2933" opacity="0.1" />
        
        <rect x="110" y="20" width="50" height="40" rx="8" fill="url(#glass-gradient)" stroke="url(#edge-gradient)" strokeWidth="1" opacity="0.8" />
        <circle cx="135" cy="40" r="10" stroke="#3B82F6" strokeWidth="2" fill="none" opacity="0.5" />
        
        <rect x="20" y="70" width="140" height="50" rx="8" fill="url(#glass-gradient)" stroke="url(#edge-gradient)" strokeWidth="1" opacity="0.8" />
        <rect x="30" y="85" width="100" height="4" rx="2" fill="#1F2933" opacity="0.2" />
        <rect x="30" y="100" width="80" height="4" rx="2" fill="#1F2933" opacity="0.1" />
      </g>

      {/* Crisp Details Layer (Top) */}
      <g className="floating-chip" transform="translate(180, 130)">
        {/* Central precise icon wrapper */}
        <circle cx="20" cy="20" r="24" fill="#FFFFFF" filter="url(#soft-shadow)" />
        {/* Spark / Star icon in Crisp deep blue */}
        <path d="M20 8 L22 17 L31 19 L22 21 L20 30 L18 21 L9 19 L18 17 Z" fill="#3B82F6" />
        {/* Mini spark */}
        <path d="M30 10 L31 13 L34 14 L31 15 L30 18 L29 15 L26 14 L29 13 Z" fill="#0EA5E9" />
      </g>
    </svg>
  );
}