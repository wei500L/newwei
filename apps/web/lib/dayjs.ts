import dayjs from "dayjs";
import type { ConfigType } from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(localizedFormat);

export const guessTimeZone = () => dayjs.tz.guess();

export const toUtcIsoString = (value: ConfigType) =>
  dayjs(value).utc().toISOString();

export default dayjs;
