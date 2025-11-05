export const formatNumber = (value: number, locale: string = "en-US") => {
  return new Intl.NumberFormat(locale).format(value);
};

export const toPercentage = (value: number, fractionDigits = 2) => {
  return `${(value * 100).toFixed(fractionDigits)}%`;
};
