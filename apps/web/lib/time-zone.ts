export function getDefaultTimeZone(): string {
  return process.env.NEXT_PUBLIC_TIME_ZONE ?? "Asia/Shanghai";
}

