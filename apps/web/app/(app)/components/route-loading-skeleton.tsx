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
        {Array.from({ length: titleBars }).map((_, index) => (
          <div
            key={index}
            className={`animate-pulse rounded bg-slate-200/80 dark:bg-slate-700/70 ${
              index === 0 ? "h-7 w-56" : "h-4 w-full max-w-xl"
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {Array.from({ length: panels }).map((_, index) => (
          <div
            key={index}
            className={`rounded-lg border border-[var(--border)] bg-white/60 p-4 shadow-sm dark:bg-slate-900/40 ${
              index === 0 && panels > 1 ? "xl:col-span-2" : ""
            }`}
          >
            <div className="mb-4 h-5 w-36 animate-pulse rounded bg-slate-200/80 dark:bg-slate-700/70" />
            <div className="space-y-3">
              {Array.from({ length: dense ? 8 : 5 }).map((__, rowIndex) => (
                <div
                  key={rowIndex}
                  className="h-4 animate-pulse rounded bg-slate-200/70 dark:bg-slate-700/60"
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
