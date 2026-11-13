import { Temporal } from "@js-temporal/polyfill";
import { TIME_ZONE } from "./domain";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function validateDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("Please select a valid date (YYYY-MM-DD).");
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" }).toString();
  } catch {
    throw new AppError("Invalid date.");
  }
}

export function validateDuration(value: unknown = 2): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 8
  ) {
    throw new AppError("Booking duration must be 1 to 8 whole hours.");
  }
  return value;
}

export function localToInstant(value: unknown): Temporal.Instant {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(value)
  ) {
    throw new AppError("Start time must be on the hour (YYYY-MM-DDTHH:00).");
  }
  try {
    return Temporal.PlainDateTime.from(value, { overflow: "reject" })
      .toZonedDateTime(TIME_ZONE, { disambiguation: "reject" })
      .toInstant();
  } catch {
    throw new AppError(
      "This local time is missing or repeated due to daylight saving. Please select another hour.",
    );
  }
}

export function bookingTimes(
  startLocal: unknown,
  duration: unknown = 2,
  future = true,
) {
  const durationHours = validateDuration(duration);
  const start = localToInstant(startLocal);
  if (future && start.epochMilliseconds <= Date.now()) {
    throw new AppError("Bookings must start in the future.");
  }
  return {
    startsAt: start.toString(),
    endsAt: start.add({ hours: durationHours }).toString(),
    durationHours,
  };
}

export function dayBounds(dateValue: string) {
  const date = Temporal.PlainDate.from(validateDate(dateValue));
  return {
    startsAt: date.toZonedDateTime(TIME_ZONE).toInstant().toString(),
    endsAt: date
      .add({ days: 1 })
      .toZonedDateTime(TIME_ZONE)
      .toInstant()
      .toString(),
  };
}

export function todayLocal(): string {
  return Temporal.Now.zonedDateTimeISO(TIME_ZONE).toPlainDate().toString();
}

export function instantToLocal(value: string): string {
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(TIME_ZONE)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}
