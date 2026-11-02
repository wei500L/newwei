export function EmptyDigestSvg() {
  return (
    <svg
      viewBox="0 0 400 300"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full max-w-[300px] mx-auto text-muted-foreground"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      {/* 主卡片线稿 */}
      <g transform="translate(110, 80)">
        <rect width="180" height="140" rx="14" strokeWidth="1.5" />
        {/* bento 内格 */}
        <rect x="20" y="20" width="80" height="40" rx="8" strokeWidth="1" />
        <rect x="30" y="32" width="40" height="4" rx="2" fill="currentColor" fillOpacity="0.12" stroke="none" />
        <rect x="30" y="44" width="60" height="4" rx="2" fill="currentColor" fillOpacity="0.08" stroke="none" />
        <rect x="110" y="20" width="50" height="40" rx="8" strokeWidth="1" />
        <circle cx="135" cy="40" r="10" strokeWidth="1.5" />
        <rect x="20" y="70" width="140" height="50" rx="8" strokeWidth="1" />
        <rect x="30" y="85" width="100" height="4" rx="2" fill="currentColor" fillOpacity="0.12" stroke="none" />
        <rect x="30" y="100" width="80" height="4" rx="2" fill="currentColor" fillOpacity="0.08" stroke="none" />
      </g>

      {/* 顶部徽标 */}
      <g transform="translate(180, 130)">
        <circle cx="20" cy="20" r="24" fill="currentColor" fillOpacity="0.06" strokeWidth="1.5" />
        <path
          d="M20 8 L22 17 L31 19 L22 21 L20 30 L18 21 L9 19 L18 17 Z"
          fill="currentColor"
          stroke="none"
        />
        <path
          d="M30 10 L31 13 L34 14 L31 15 L30 18 L29 15 L26 14 L29 13 Z"
          fill="currentColor"
          fillOpacity="0.7"
          stroke="none"
        />
      </g>
    </svg>
  );
}
