import { randomUUID } from "node:crypto";
import {
  bookingAIEnabled,
  interpretBookingText,
  type BookingAIContext,
  type BookingInterpretation,
} from "./booking-ai";
import type { Booking } from "@/lib/domain";
import {
  AppError,
  cancelBooking,
  claimChannelState,
  createBooking,
  getAvailability,
  getBooking,
  getChannelEvent,
  getChannelState,
  hash,
  listBookings,
  rateLimit,
  runChannelEvent,
  setChannelState,
  updateBooking,
} from "@/lib/store";
import { bookingTimes, instantToLocal } from "@/lib/time";
import {
  availabilityReply,
  bookingSummary,
  COMMAND_HELP,
  executeCommand,
} from "./commands";
import { channelError } from "./security";

type Action = NonNullable<BookingInterpretation["action"]>;
type Identity = { channel: "sms"; phone: string };
type Draft = {
  revision: string;
  step: "collect" | "credentials" | "confirm" | "idle";
  action?: Action;
  date?: string;
  court?: number;
  hour?: string;
  duration?: number;
  name?: string;
  id?: string;
  code?: string;
  original?: Booking;
  requestedChange?: boolean;
};

const pendingEvents = new Map<string, Promise<string>>();
const STALE_REPLY =
  "您已发送更新的信息，请按最新回复继续；尚未执行这条旧消息。";
const FALLBACK =
  "暂时无法理解这条消息，请补充预约日期、场地、整点时间和公开姓名，或发送“帮助”使用格式指令。尚未执行新的操作。";
const CREDENTIAL_HELP =
  "请发送八位预约编号和十位管理码（例如：编号 12345678 管理码 0123456789）。管理码仅在本地核验。";

function readDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Draft;
    return value && typeof value.revision === "string" ? value : null;
  } catch {
    return null;
  }
}

function saveDraft(key: string, draft: Omit<Draft, "revision">) {
  setChannelState(key, JSON.stringify({ ...draft, revision: randomUUID() }));
}

function exactCommand(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  const action = parts[0].toUpperCase();
  if (!text.trim() || ["帮助", "HELP", "?"].includes(action)) return true;
  if (["查询", "QUERY"].includes(action))
    return parts.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]);
  if (["预订", "预约", "BOOK"].includes(action))
    return (
      parts.length >= 4 &&
      /^\d+$/.test(parts[1]) &&
      /^\d{4}-\d{2}-\d{2}$/.test(parts[2]) &&
      /^\d{2}:00$/.test(parts[3])
    );
  if (["查看", "VIEW", "取消", "CANCEL", "修改", "CHANGE"].includes(action))
    return (
      parts.length >= 3 && /^\d{8}$/.test(parts[1]) && /^\d{10}$/.test(parts[2])
    );
  return false;
}

function denied(text: string): boolean {
  return /不要(?:确认|预约|预订|修改|取消)|不(?:要)?确认|别(?:确认|预约|预订|修改|取消)|先不(?:确认|预约|预订)|算了|放弃|取消(?:本次|这次|当前)(?:操作|预约)?|^(?:不|不要|不用|否|no)[，,！!。.:\s]|^(?:不|不要|不用|否|no|stop|取消)[！!。.，,\s]*$/i.test(
    text,
  );
}

function confirmation(text: string): Action | null {
  const raw = text.trim().replace(/[。！!.\s]+$/g, "");
  if (/^(?:我)?确认(?:预约|预订|订场)$|^confirm booking$/i.test(raw))
    return "book";
  if (/^(?:我)?确认修改$|^confirm change$/i.test(raw)) return "change";
  if (/^(?:我)?确认取消(?:预约)?$|^confirm cancellation$/i.test(raw))
    return "cancel";
  return null;
}

function localAction(text: string): Action | undefined {
  if (/取消|cancel/i.test(text)) return "cancel";
  if (/修改|更改|改到|改成|change/i.test(text)) return "change";
  if (/查看|查下|查询预约|view/i.test(text)) return "view";
}

function hasCredentials(text: string) {
  return /管理码|预约编号|access\s*code|booking\s*(?:id|number)|\d{8,}/i.test(
    text,
  );
}

function contextStep(draft: Draft | null): string {
  if (!draft?.action) return "start";
  if (draft.step === "credentials" || draft.step === "confirm")
    return draft.step;
  if (!draft.date) return "date";
  if (![1, 2].includes(draft.court ?? 0)) return "court";
  if (!draft.hour) return "hour";
  if (!draft.name) return "name";
  return "collect";
}

// Credential-bearing messages never reach the model, even when they also
// describe a change. Only these unambiguous local field formats are accepted.
function localFields(text: string): Partial<Draft> {
  if (
    /(?:点|時|时)|半(?:个)?小时|(?:一|三|1|3)刻|\b(?:half|quarter|am|pm)\b|上午|下午|早上|晚上|凌晨|中午|今晚|明天|后天|下周|\d{4}[/.年]\d{1,2}/i.test(
      text.replace(/小时/g, ""),
    ) ||
    /半(?:个)?小时/.test(text)
  )
    throw new AppError(
      "含编号或管理码的消息，请使用日期YYYY-MM-DD和24小时整点HH:00；也可先单独核验编号管理码，再发送修改需求。尚未修改预约。",
    );
  const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const clock = text.match(/(?<!\d)(\d+):(\d+)(?!\d)/);
  if (
    clock &&
    (clock[1].length > 2 || Number(clock[1]) > 23 || clock[2] !== "00")
  )
    throw new AppError(
      "开始时间必须为00:00至23:00的整点，请重新提供修改信息。尚未修改预约。",
    );
  const hour = clock?.[1];
  const court = text.match(
    /(\d+|[零〇一二两三四五六七八九十百]+)\s*号?(?:球)?场|court\s*(\d+)/i,
  );
  const duration = text.match(
    /(?<![\d.．零〇一二两三四五六七八九十百])(\d+(?:[.．]\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:(?:个)?小时|hours?\b|h\b)/i,
  )?.[1];
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
  };
  const courtNumber = court
    ? (digits[court[1]] ?? Number(court[1] || court[2]))
    : undefined;
  if (courtNumber !== undefined && ![1, 2].includes(courtNumber))
    throw new AppError("请选择1号场或2号场。尚未修改预约。");
  const durationNumber = duration
    ? (digits[duration] ?? Number(duration))
    : undefined;
  if (
    durationNumber !== undefined &&
    (!Number.isInteger(durationNumber) ||
      durationNumber < 1 ||
      durationNumber > 8)
  )
    throw new AppError(
      "预约时长必须是1至8个完整小时，请重新提供修改信息。尚未修改预约。",
    );
  return {
    ...(date ? { date } : {}),
    ...(hour ? { hour: hour.padStart(2, "0") } : {}),
    ...(courtNumber !== undefined ? { court: courtNumber } : {}),
    ...(durationNumber !== undefined ? { duration: durationNumber } : {}),
  };
}

function prompt(draft: Draft): string {
  if (!draft.action) return "您想查询空闲时间、预约、修改、取消还是查看预约？";
  if (["view", "change", "cancel"].includes(draft.action) && !draft.original)
    return CREDENTIAL_HELP;
  if (draft.action === "cancel")
    return `${bookingSummary(draft.original!)}如确认取消，请另发“确认取消”；放弃请回复“不要”。`;
  if (!draft.date) return "请告诉我预约日期（YYYY-MM-DD，悉尼时间）。";
  if (draft.action === "query") return "请告诉我想查询的日期。";
  if (![1, 2].includes(draft.court ?? 0)) return "请选择1号场或2号场。";
  if (!draft.hour) return "请告诉我开始的整点时间（例如14:00，悉尼时间）。";
  if (!draft.name)
    return "请告诉我预约姓名。姓名会公开展示，请勿使用电话等敏感信息。";
  if (draft.action === "change" && !draft.requestedChange)
    return "请告诉我需要修改的日期、场地、整点时间或小时数。";
  const verb = draft.action === "change" ? "修改" : "预约";
  return `请核对${verb}：${draft.date} ${draft.hour}:00，${draft.court}号场，${draft.duration ?? 2}小时，姓名${draft.name}（悉尼时间）。姓名会公开展示。确认后请另发“确认${verb}”；需要更正可直接说明，放弃请回复“不要”。`;
}

function ready(draft: Draft): boolean {
  if (draft.action === "cancel") return !!draft.original;
  return (
    !!draft.date &&
    [1, 2].includes(draft.court ?? 0) &&
    !!draft.hour &&
    !!draft.name &&
    (draft.action !== "change" || !!draft.requestedChange)
  );
}

function advance(key: string, draft: Draft): string {
  // A correction invalidates an earlier confirmation even when its replacement
  // turns out to be invalid. The user must review a fresh summary before a write.
  draft.step = "collect";
  saveDraft(key, draft);
  if (
    ["view", "change", "cancel"].includes(draft.action ?? "") &&
    !draft.original
  ) {
    draft.step = "credentials";
  } else if (draft.action === "view") {
    const reply = bookingSummary(draft.original!);
    saveDraft(key, { step: "idle" });
    return reply;
  } else if (draft.action === "query" && draft.date) {
    const reply = availabilityReply(
      draft.date,
      draft.court ?? 0,
      draft.duration ?? 2,
    );
    draft.step = "collect";
    saveDraft(key, draft);
    return reply;
  } else if (ready(draft)) {
    if (draft.action !== "cancel") {
      const times = bookingTimes(
        `${draft.date}T${draft.hour}:00`,
        draft.duration ?? 2,
      );
      if (draft.name!.length > 80 || /[\x00-\x1f]|\d{6,}|@/.test(draft.name!))
        throw new AppError(
          "姓名需要为1至80个字符，请勿填写电话或邮箱。请重新告诉我公开姓名。",
        );
      if (draft.action === "book") {
        const slot = getAvailability(
          draft.date!,
          draft.duration ?? 2,
        ).slots.find(
          (item) =>
            item.courtId === draft.court &&
            item.startLocal === `${draft.date}T${draft.hour}:00`,
        );
        if (!slot?.available) {
          draft.step = "collect";
          saveDraft(key, draft);
          return "该场地时间段不可预约，请告诉我其他时间或球场，也可查询可用时间。";
        }
      } else if (draft.action === "change") {
        const nearby = [
          ...listBookings(draft.date!),
          ...listBookings(instantToLocal(times.endsAt).slice(0, 10)),
        ];
        if (
          nearby.some(
            (item) =>
              item.id !== draft.id &&
              item.status === "confirmed" &&
              item.courtId === draft.court &&
              Date.parse(item.startsAt) < Date.parse(times.endsAt) &&
              Date.parse(item.endsAt) > Date.parse(times.startsAt),
          )
        ) {
          return "该场地时间段已被预约，请告诉我其他时间或球场，也可查询可用时间。";
        }
      }
    }
    draft.step = "confirm";
  } else draft.step = "collect";
  saveDraft(key, draft);
  return prompt(draft);
}

function authorize(key: string, text: string, old: Draft | null): string {
  const action = localAction(text) ?? old?.action;
  if (!action || !["view", "change", "cancel"].includes(action))
    return CREDENTIAL_HELP;
  const draft: Draft =
    old && old.action === action
      ? { ...old }
      : { revision: "", step: "credentials", action };
  const id = text.match(/(?<!\d)\d{8}(?!\d)/)?.[0];
  const code = text.match(/(?<!\d)\d{10}(?!\d)/)?.[0];
  if ((id && id !== draft.id) || (code && code !== draft.code))
    delete draft.original;
  draft.id = id ?? draft.id;
  draft.code = code ?? draft.code;
  // Invalidate an earlier summary before parsing replacement fields: parsing
  // can fail, and a later confirmation must never commit the older proposal.
  draft.step = draft.original ? "collect" : "credentials";
  saveDraft(key, draft);
  const fields = localFields(text);
  Object.assign(draft, fields);
  if (Object.keys(fields).length) draft.requestedChange = true;
  if (!draft.id || !draft.code) {
    saveDraft(key, draft);
    return CREDENTIAL_HELP;
  }
  const booking = getBooking(draft.id, draft.code);
  draft.original = booking;
  if (action === "change") {
    const local = instantToLocal(booking.startsAt);
    draft.date ??= local.slice(0, 10);
    draft.hour ??= local.slice(11, 13);
    draft.court ??= booking.courtId;
    draft.duration ??= booking.durationHours;
    draft.name ??= booking.customerName;
  }
  return advance(key, draft);
}

function applyInterpretation(
  key: string,
  old: Draft | null,
  value: BookingInterpretation | null,
): string {
  if (!value || value.scope === "unclear") return FALLBACK;
  if (value.scope === "off_topic")
    return "我只能帮助查询和管理网球场预约。请告诉我预约需求，或发送“帮助”。";
  const action =
    value.correction && old?.action && value.action === "change"
      ? old.action
      : (value.action ?? old?.action);
  if (!action) return "您想查询空闲时间、预约、修改、取消还是查看预约？";
  const draft: Draft =
    old && old.action === action
      ? { ...old }
      : { revision: "", step: "collect", action };
  if (value.correction === "contact")
    return "短信预约使用当前发信号码作为联系电话。请继续提供预约日期、场地、时间或姓名。";
  const fields = ["date", "court", "hour", "duration", "name"] as const;
  for (const field of fields) {
    if (value.correction === field && value[field] === null)
      delete draft[field];
    if (value[field] !== null) Object.assign(draft, { [field]: value[field] });
  }
  if (action === "change" && fields.some((field) => value[field] !== null))
    draft.requestedChange = true;
  if (action !== "change") draft.duration ??= 2;
  return advance(key, draft);
}

function commit(key: string, draft: Draft, identity: Identity): string {
  let reply: string;
  if (draft.action === "book") {
    const result = createBooking({
      courtId: draft.court!,
      startLocal: `${draft.date}T${draft.hour}:00`,
      durationHours: draft.duration ?? 2,
      customerName: draft.name!,
      phone: identity.phone,
      source: identity.channel,
    });
    reply = `${bookingSummary(result.booking)}管理码：${result.accessCode}。请妥善保存编号和管理码，凭此可查看、修改、取消。姓名已公开展示。`;
  } else if (draft.action === "cancel") {
    reply = bookingSummary(
      cancelBooking(draft.id!, draft.original!.version, draft.code),
    );
  } else if (draft.action === "change") {
    const original = draft.original!;
    reply = bookingSummary(
      updateBooking(
        draft.id!,
        {
          courtId: draft.court!,
          startLocal: `${draft.date}T${draft.hour}:00`,
          durationHours: draft.duration ?? 2,
          customerName: draft.name!,
          phone: original.phone,
          email: original.email,
          source: original.source,
          version: original.version,
        },
        draft.code,
      ),
    );
  } else return FALLBACK;
  saveDraft(key, { step: "idle" });
  return reply;
}

/** The injectable interpreter keeps channel tests fully offline. */
export function createTextAssistant(understand = interpretBookingText) {
  return async function handle(
    text: string,
    identity: Identity,
    eventKey: string,
  ): Promise<string> {
    const cached = getChannelEvent(eventKey);
    if (cached !== null) return JSON.parse(cached) as string;
    const pending = pendingEvents.get(eventKey);
    if (pending) return pending;
    const work = processMessage(text, identity, eventKey, understand);
    pendingEvents.set(eventKey, work);
    try {
      return await work;
    } finally {
      pendingEvents.delete(eventKey);
    }
  };
}

async function processMessage(
  text: string,
  identity: Identity,
  eventKey: string,
  understand: typeof interpretBookingText,
): Promise<string> {
  const lease = `sms:lease:${hash(eventKey)}`;
  if (!claimChannelState(lease, "processing", 15_000)) {
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cached = getChannelEvent(eventKey);
      if (cached !== null) return JSON.parse(cached) as string;
    }
    throw new AppError("这条短信正在处理，请稍后重试", 503);
  }
  try {
    rateLimit(`sms:${identity.phone}`, 30, 900_000);
    const key = `sms:draft:${hash(identity.phone)}`;
    const snapshot = getChannelState(key);
    const draft = readDraft(snapshot);
    const legacy = !bookingAIEnabled() || exactCommand(text);
    const reject = !legacy && denied(text);
    const confirm = !legacy && !reject ? confirmation(text) : null;
    const credentials = !legacy && !reject && !confirm && hasCredentials(text);
    let understood: BookingInterpretation | null = null;
    if (!legacy && !reject && !confirm && !credentials && text.length <= 1000) {
      const context: BookingAIContext = {
        channel: identity.channel,
        step: contextStep(draft),
        action: draft?.action,
        date: draft?.date,
        court: draft?.court,
        hour: draft?.hour,
        duration: draft?.duration,
      };
      understood = await understand(text, context);
    }
    // All mutations and the cached final reply remain in one synchronous
    // transaction. No model/network await occurs inside a SQLite transaction.
    return runChannelEvent(eventKey, () => {
      if (getChannelState(key) !== snapshot) return STALE_REPLY;
      try {
        if (text.length > 1000) throw new AppError("指令内容过长", 400);
        if (legacy) {
          const reply = executeCommand(text, identity);
          saveDraft(key, { step: "idle" });
          return reply;
        }
        if (reject) {
          saveDraft(key, { step: "idle" });
          return "已放弃当前操作。您可以重新查询或预约球场。";
        }
        if (confirm) {
          if (draft?.step !== "confirm" || draft.action !== confirm)
            return draft?.action
              ? `尚未完成并核对这项操作。${prompt(draft)}`
              : "目前没有待确认的操作。请先告诉我预约需求。";
          try {
            return commit(key, draft, identity);
          } catch (error) {
            saveDraft(key, { ...draft, step: "collect" });
            return `${channelError(error)}请重新提供需要的预约信息并核对后再确认。`;
          }
        }
        if (credentials) return authorize(key, text, draft);
        return applyInterpretation(key, draft, understood);
      } catch (error) {
        return channelError(error);
      }
    });
  } finally {
    setChannelState(lease, null);
  }
}

export const handleTextMessage = createTextAssistant();

// Preserve a single authoritative command guide for deterministic fallback.
export { COMMAND_HELP };
