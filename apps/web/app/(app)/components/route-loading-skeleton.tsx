interface RouteLoadingSkeletonProps {
  titleBars?: number;
  panels?: number;
  dense?: boolean;
}

export function RouteLoadingSkeleton({
  titleBars = 2,
  panels = 3,
  dense = false,
}: RouteLoadingSkeletonProps) {
  return (
    <div className="flex w-full flex-col gap-4 pb-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className="h-3 w-24 animate-pulse rounded bg-[var(--surface-muted)]" />
        {Array.from({ length: titleBars }).map((_, index) => (
          <div
            key={index}
            className={`animate-pulse rounded bg-[var(--surface-muted)] ${
              index === 0 ? "h-7 w-56" : "h-4 w-full max-w-xl"
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {Array.from({ length: panels }).map((_, index) => (
          <div
            key={index}
            className={`content-card p-4 ${
              index === 0 && panels > 1 ? "xl:col-span-2" : ""
            }`}
          >
            <div className="mb-4 h-5 w-36 animate-pulse rounded bg-[var(--surface-muted)]" />
            <div className="space-y-3">
              {Array.from({ length: dense ? 8 : 5 }).map((__, rowIndex) => (
                <div
                  key={rowIndex}
                  className="h-4 animate-pulse rounded bg-[var(--surface-muted)]"
                  style={{ width: `${92 - (rowIndex % 3) * 14}%` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
