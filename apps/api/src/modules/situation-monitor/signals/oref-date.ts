/**
 * Shared OREF timestamp parsing.
 *
 * OREF (Israel Home Front Command) emits naive local timestamps in the form
 * "YYYY-MM-DD HH:mm:ss" with no timezone. They are Asia/Jerusalem wall-clock
 * times (UTC+2/UTC+3 with DST). Parsing them with the server's local zone
 * shifts matches by 2–3 hours and makes realtime alerts disagree with the
 * history store, so both the realtime and monitor paths must use this same
 * conversion.
 */
export function orefDateToUtc(dateStr: string): string {
  if (!dateStr || !dateStr.includes(" ")) {
    return new Date().toISOString();
  }

  const [datePart, timePart] = dateStr.split(" ");
  if (!datePart || !timePart) {
    return new Date().toISOString();
  }

  const dateSegments = datePart.split("-");
  const timeSegments = timePart.split(":");
  if (dateSegments.length !== 3 || timeSegments.length !== 3) {
    return new Date().toISOString();
  }

  const year = Number(dateSegments[0]);
  const month = Number(dateSegments[1]);
  const day = Number(dateSegments[2]);
  const hours = Number(timeSegments[0]);
  const minutes = Number(timeSegments[1]);
  const seconds = Number(timeSegments[2]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return new Date().toISOString();
  }

  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const partsAt = (ms: number): string => {
    const parts = Object.fromEntries(
      format
        .formatToParts(new Date(ms))
        .map((entry) => [entry.type, entry.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };

  const utc2 = Date.UTC(year, month - 1, day, hours - 2, minutes, seconds);
  const utc3 = Date.UTC(year, month - 1, day, hours - 3, minutes, seconds);

  const candidates: number[] = [];
  if (partsAt(utc2) === dateStr) candidates.push(utc2);
  if (partsAt(utc3) === dateStr) candidates.push(utc3);

  const selected = candidates.length > 0 ? Math.min(...candidates) : utc2;
  return new Date(selected).toISOString();
}
