import type { Booking, Channel } from "@/lib/domain";
import { TIME_ZONE } from "@/lib/domain";
import {
  AppError,
  cancelBooking,
  createBooking,
  getAvailability,
  getBooking,
  updateBooking,
} from "@/lib/store";

export const COMMAND_HELP =
  "指令：查询 日期 [场地号0/1/2] [小时数]；预订 场地号 日期 HH:00 姓名 [小时数]；修改 编号 管理码 场地号 日期 HH:00 [小时数]；取消 编号 管理码；查看 编号 管理码。日期格式YYYY-MM-DD，默认2小时，时区悉尼。姓名将公开展示，请勿填写电话等敏感信息。";

type Identity = {
  channel: Extract<Channel, "sms" | "email" | "phone">;
  phone?: string;
  email?: string;
};

export function bookingSummary(booking: Booking): string {
  const format = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `预约${booking.id}，${booking.courtId}号场，${format.format(new Date(booking.startsAt))}至${format.format(new Date(booking.endsAt))}，${booking.durationHours}小时，${booking.status === "cancelled" ? "已取消" : "已确认"}（悉尼时间）。`;
}

function validateLength(parts: string[], low: number, high = low) {
  if (parts.length < low || parts.length > high)
    throw new AppError(`指令格式不正确。${COMMAND_HELP}`, 400);
}

export function availabilityReply(
  date: string,
  court = 0,
  duration = 2,
): string {
  if (![0, 1, 2].includes(court))
    throw new AppError("场地号只能是0（全部）、1或2", 400);
  const availability = getAvailability(date, duration);
  const lines = [date + `可开始时间（悉尼时间，每场${duration}小时）：`];
  for (const item of availability.courts.filter(
    (item) => court === 0 || court === item.id,
  )) {
    const hours = availability.slots
      .filter((slot) => slot.courtId === item.id && slot.available)
      .map((slot) => Number(slot.startLocal.slice(11, 13)));
    const groups: number[][] = [];
    for (const hour of hours) {
      const last = groups.at(-1);
      if (last && last.at(-1) === hour - 1) last.push(hour);
      else groups.push([hour]);
    }
    const stamp = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
    const starts = groups
      .map((group) =>
        group.length === 1
          ? stamp(group[0])
          : `${stamp(group[0])}–${stamp(group.at(-1)!)}（每小时）`,
      )
      .join("、");
    lines.push(`${item.id}号场：${starts || "暂无可用时段"}。`);
  }
  return lines.join("\n");
}

export function executeCommand(command: string, identity: Identity): string {
  if (command.length > 1000) throw new AppError("指令内容过长", 400);
  const parts = command.trim().split(/\s+/);
  const action = parts[0]?.toUpperCase();
  if (!command.trim() || ["帮助", "HELP", "?"].includes(action))
    return COMMAND_HELP;
  if (["查询", "QUERY"].includes(action)) {
    validateLength(parts, 2, 4);
    return availabilityReply(
      parts[1],
      Number(parts[2] ?? 0),
      Number(parts[3] ?? 2),
    );
  }
  if (["预订", "预约", "BOOK"].includes(action)) {
    validateLength(parts, 5, 6);
    const result = createBooking({
      courtId: Number(parts[1]),
      startLocal: `${parts[2]}T${parts[3]}`,
      customerName: parts[4],
      durationHours: Number(parts[5] ?? 2),
      phone: identity.phone,
      email: identity.email,
      source: identity.channel,
    });
    return `${bookingSummary(result.booking)}管理码：${result.accessCode}。请妥善保存编号和管理码，凭此可查看、修改、取消。姓名已公开展示。`;
  }
  if (["查看", "VIEW"].includes(action)) {
    validateLength(parts, 3);
    return bookingSummary(getBooking(parts[1], parts[2]));
  }
  if (["取消", "CANCEL"].includes(action)) {
    validateLength(parts, 3);
    const booking = getBooking(parts[1], parts[2]);
    return bookingSummary(cancelBooking(booking.id, booking.version, parts[2]));
  }
  if (["修改", "CHANGE"].includes(action)) {
    validateLength(parts, 6, 7);
    const booking = getBooking(parts[1], parts[2]);
    const updated = updateBooking(
      booking.id,
      {
        courtId: Number(parts[3]),
        startLocal: `${parts[4]}T${parts[5]}`,
        durationHours: Number(parts[6] ?? 2),
        customerName: booking.customerName,
        phone: booking.phone,
        email: booking.email,
        source: booking.source,
        version: booking.version,
      },
      parts[2],
    );
    return bookingSummary(updated);
  }
  throw new AppError(`无法识别指令。${COMMAND_HELP}`, 400);
}
