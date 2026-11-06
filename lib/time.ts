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
    throw new AppError("请选择有效日期（YYYY-MM-DD）");
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" }).toString();
  } catch {
    throw new AppError("日期无效");
  }
}

export function validateDuration(value: unknown = 2): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 8
  ) {
    throw new AppError("预约时长必须是 1 至 8 个完整小时");
  }
  return value;
}

export function localToInstant(value: unknown): Temporal.Instant {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(value)
  ) {
    throw new AppError("开始时间必须为整点（YYYY-MM-DDTHH:00）");
  }
  try {
    return Temporal.PlainDateTime.from(value, { overflow: "reject" })
      .toZonedDateTime(TIME_ZONE, { disambiguation: "reject" })
      .toInstant();
  } catch {
    throw new AppError("该本地时间不存在或因夏令时重复，请选择其他整点");
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
    throw new AppError("只能预约未来的时间");
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
