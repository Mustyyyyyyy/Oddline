export type GenerationPeriod = "daily" | "weekend";

export interface GenerationWindow {
  startsAt: Date;
  endsAt: Date;
}

interface ZonedDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function getGenerationWindow(
  period: GenerationPeriod,
  timeZone: string,
  now = new Date(),
): GenerationWindow {
  if (!isSupportedTimeZone(timeZone)) throw new Error("Choose a valid time zone.");
  const today = getZonedDateTime(now, timeZone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));

  if (period === "weekend") {
    const dayOfWeek = date.getUTCDay();
    const daysUntilFriday = dayOfWeek === 0 ? -2 : 5 - dayOfWeek;
    date.setUTCDate(date.getUTCDate() + daysUntilFriday);
  }
  return windowStartingOn(date, period, timeZone);
}

export function isSundayInTimeZone(date: Date, timeZone: string): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date) === "Sun";
}

export function getNextWeekendWindow(timeZone: string, now = new Date()): GenerationWindow {
  if (!isSupportedTimeZone(timeZone)) throw new Error("Choose a valid time zone.");
  const today = getZonedDateTime(now, timeZone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const dayOfWeek = date.getUTCDay();
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilFriday);
  return windowStartingOn(date, "weekend", timeZone);
}

function windowStartingOn(
  date: Date,
  period: GenerationPeriod,
  timeZone: string,
): GenerationWindow {
  const startDate = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  const endDate = new Date(Date.UTC(startDate.year, startDate.month - 1, startDate.day + (period === "daily" ? 1 : 3)));
  const end = { year: endDate.getUTCFullYear(), month: endDate.getUTCMonth() + 1, day: endDate.getUTCDate() };
  return {
    startsAt: localMidnightAsUtc(startDate, timeZone),
    endsAt: localMidnightAsUtc(end, timeZone),
  };
}

function getZonedDateTime(date: Date, timeZone: string): ZonedDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map(({ type, value }) => [type, Number(value)]));
  return {
    year: values.get("year")!,
    month: values.get("month")!,
    day: values.get("day")!,
    hour: values.get("hour")!,
    minute: values.get("minute")!,
    second: values.get("second")!,
  };
}

function localMidnightAsUtc(
  date: Pick<ZonedDateTime, "year" | "month" | "day">,
  timeZone: string,
): Date {
  const targetAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = getZonedDateTime(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    guess += targetAsUtc - representedAsUtc;
  }
  return new Date(guess);
}
