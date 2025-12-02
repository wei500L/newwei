export const formatDateTime = (
  date: Date | string | number,
  locale: Intl.LocalesArgument = "en-US"
) => {
  const value = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
};

export const toISODate = (date: Date | string | number) => {
  const value = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return value.toISOString();
};

export const durationInSeconds = (start: Date, end: Date = new Date()) => {
  return Math.round((end.getTime() - start.getTime()) / 1000);
};
