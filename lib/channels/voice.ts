import { randomUUID } from "node:crypto";
import type { Booking } from "@/lib/domain";
import { COURTS } from "@/lib/domain";
import {
  AppError,
  cancelBooking,
  createBooking,
  getAvailability,
  getBooking,
  getChannelState,
  listBookings,
  setChannelState,
  updateBooking,
} from "@/lib/store";
import {
  bookingTimes,
  instantToLocal,
  todayLocal,
  validateDate,
  validateDuration,
} from "@/lib/time";
import type { BookingAIContext, BookingInterpretation } from "./booking-ai";
import { phoneSmsPendingPrompt, queuePhoneBookingSms } from "./phone-sms";
import { baseUrl, channelError, escapeXml } from "./security";
import { VOICE_CAPTURE } from "./voice-capture";
import {
  spokenAccessCode,
  spokenBookingSummary,
  spokenDate,
  spokenDuration,
  spokenHourRange,
} from "./voice-speech";
import {
  explicitConfirmation,
  isOffTopic,
  parseCalendarDate,
  parseDurationSpeech,
  parseHourSpeech,
  parseIntent,
  parseNameSpeech,
  parsePhoneSpeech,
  stripSpeech,
  usesCallerNumber,
} from "./voice-input";

type Action = "query" | "book" | "change" | "cancel" | "view";
type Step =
  | "menu"
  | "date"
  | "court"
  | "hour"
  | "duration"
  | "name"
  | "contact"
  | "id"
  | "code"
  | "confirm";
type VoiceState = {
  turn: string;
  step: Step;
  action?: Action;
  date?: string;
  court?: number;
  hour?: string;
  duration?: number;
  name?: string;
  contactPhone?: string;
  contactUsesCallerNumber?: boolean;
  namePrivacyNoticeGiven?: boolean;
  id?: string;
  code?: string;
  version?: number;
  silences?: number;
  introduced?: boolean;
};

const EXIT = /^(不预约了|不预订了|退出|结束通话|挂断|再见|算了)$/;

/** The model receives scheduling context only. Credentials and contact answers
 * always stay in the deterministic state machine. */
export function voiceAIContext(
  callSid: string,
  turn: string | null,
  digits: string,
  speech: string,
): BookingAIContext | null {
  const state = currentVoiceState(callSid);
  const text = stripSpeech(speech);
  const withoutDates = text.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, "");
  if (
    !turn ||
    !state ||
    state.turn !== turn ||
    digits ||
    !text ||
    ["id", "code", "contact"].includes(state.step) ||
    EXIT.test(text) ||
    isOffTopic(text) ||
    explicitConfirmation(text) ||
    /确认|確認|确定|確定|\bconfirm\b/i.test(text) ||
    /电话|電話|联系|聯繫|管理码|管理碼|验证码|驗證碼|预约编号|預約編號|邮箱|郵箱|@/.test(
      text,
    ) ||
    /(?:[0-9零〇一幺二两三四五六七八九][\s，,-]*){7,}/.test(withoutDates)
  )
    return null;
  return {
    channel: "phone",
    step: state.step,
    ...(state.action ? { action: state.action } : {}),
    ...(state.date ? { date: state.date } : {}),
    ...(state.court !== undefined ? { court: state.court } : {}),
    ...(state.hour ? { hour: state.hour } : {}),
    ...(state.duration ? { duration: state.duration } : {}),
  };
}

function say(text: string) {
  return `<Say language="cmn-CN" voice="Polly.Zhiyu">${escapeXml(text)}</Say>`;
}
function stateSummary(state: VoiceState) {
  const times = bookingTimes(
    `${state.date}T${state.hour}:00`,
    state.duration,
    false,
  );
  return spokenBookingSummary({ ...times, courtId: state.court! });
}
function prompt(state: VoiceState): string {
  switch (state.step) {
    case "menu":
      return state.introduced
        ? "还需要预约球场或查空档吗？"
        : "您好，想预约球场还是查空档？";
    case "date":
      return state.action === "query" ? "想查哪一天？" : "想订哪一天？";
    case "court":
      return "想从几点开始？请说整点。";
    case "hour":
      return "想从几点开始？请说整点。";
    case "duration":
      return state.action === "query"
        ? "想查几个小时的空档？默认两小时。"
        : "订几个小时？默认两小时。";
    case "name":
      return "预约人叫什么名字？姓名会公开显示在网站日程上。";
    case "contact":
      return "联系电话是多少？用来电号码请说使用来电号码或按1。";
    case "id":
      return "请说八位预约编号，也可以按键输入。";
    case "code":
      return "请说十位管理码，也可以按键输入。";
    case "confirm":
      return state.action === "cancel"
        ? `要取消${spokenBookingSummary(originalBooking(state))}请说确认取消或按1。保留请说不确认或按2。`
        : `${state.action === "change" ? "修改为：" : "请核对："}${state.namePrivacyNoticeGiven ? "" : "姓名会公开显示在网站日程上。"}预约人${state.name}，联系电话${state.contactUsesCallerNumber ? "使用来电号码" : spokenAccessCode(state.contactPhone || "")}。${stateSummary(state)}确认请说确认预约或按1；需要调整请直接说，不确认请说不确认或按2。`;
  }
}
function renderGather(state: VoiceState, prefix = "", promptState = state) {
  const action = `${baseUrl()}/api/webhooks/voice?turn=${state.turn}`;
  const numbers: Partial<Record<Step, number>> = {
    menu: 1,
    date: 8,
    court: 1,
    hour: 2,
    duration: 1,
    id: 8,
    code: 10,
    confirm: 1,
  };
  const input = `input="dtmf speech" language="${VOICE_CAPTURE.language}" speechTimeout="${VOICE_CAPTURE.speechPauseSeconds}" timeout="${VOICE_CAPTURE.startTimeoutSeconds}" finishOnKey="#"${numbers[state.step] ? ` numDigits="${numbers[state.step]}"` : ""}`;
  // Keep all spoken guidance inside Gather so the caller is heard while an
  // availability explanation or a recovery prompt is being read.
  return `<Gather ${input} action="${escapeXml(action)}" method="POST" actionOnEmptyResult="true">${prefix ? say(prefix) : ""}${say(prompt(promptState))}</Gather>`;
}
function respond(callSid: string, state: VoiceState, prefix = "") {
  const next = {
    ...state,
    turn: randomUUID(),
    introduced: true,
    namePrivacyNoticeGiven:
      state.namePrivacyNoticeGiven ||
      state.step === "name" ||
      (state.step === "confirm" && state.action !== "cancel"),
  };
  setChannelState(`voice:${callSid}`, JSON.stringify(next));
  return renderGather(next, prefix, state);
}
function menu(callSid: string, prefix = "") {
  return respond(
    callSid,
    { step: "menu", turn: "", introduced: Boolean(prefix) },
    prefix,
  );
}
function currentVoiceState(callSid: string): VoiceState | null {
  const saved = getChannelState(`voice:${callSid}`);
  if (!saved) return null;
  try {
    const state = JSON.parse(saved) as VoiceState;
    if (
      !state ||
      typeof state !== "object" ||
      !/^[a-f0-9-]{36}$/.test(state.turn) ||
      ![
        "menu",
        "date",
        "court",
        "hour",
        "duration",
        "name",
        "contact",
        "id",
        "code",
        "confirm",
      ].includes(state.step)
    )
      return null;
    // Calls already in progress may still contain the old court-selection step.
    // Keep their turn valid while moving them to the next scheduling question.
    return state.step === "court"
      ? {
          ...state,
          court: undefined,
          step: state.date
            ? state.action === "query"
              ? "duration"
              : "hour"
            : "date",
        }
      : state;
  } catch {
    return null;
  }
}
export function voiceProgress(
  callSid: string,
): { step: Step; turn: string } | null {
  const state = currentVoiceState(callSid);
  return state ? { step: state.step, turn: state.turn } : null;
}
// An incomplete callback may repeat a question, but must never consume a
// confirmation against a newer state or replay the cached initial greeting.
export function recoverVoiceTurn(callSid: string): string {
  const state = currentVoiceState(callSid);
  if (!state)
    return menu(callSid, "本次会话已中断，尚未提交新的操作，请重新选择。 ");
  return renderGather(
    { ...state, introduced: true },
    "没有取得这次回答，请再次回答当前问题。尚未提交新的操作。 ",
  );
}
function originalBooking(state: VoiceState): Booking {
  return getBooking(state.id!, state.code!);
}
function availabilityReply(date: string, duration = 2): string {
  const availability = getAvailability(date, duration);
  const lines = [
    `${spokenDate(date)}可开始时间，悉尼时间，每场${spokenDuration(duration)}。`,
  ];
  for (const item of availability.courts) {
    const hours = availability.slots
      .filter((slot) => slot.courtId === item.id && slot.available)
      .map((slot) => Number(slot.startLocal.slice(11, 13)));
    const groups: number[][] = [];
    for (const hour of hours) {
      const last = groups.at(-1);
      if (last && last.at(-1) === hour - 1) last.push(hour);
      else groups.push([hour]);
    }
    const starts = groups
      .map((group) => spokenHourRange(group[0], group.at(-1)!))
      .join("、");
    lines.push(`${item.id}号场：${starts || "暂无可用时段"}。`);
  }
  return lines.join("");
}
function availableCourts(state: VoiceState): number[] {
  const times = bookingTimes(`${state.date}T${state.hour}:00`, state.duration);
  const excluding = state.action === "change" ? originalBooking(state).id : "";
  // Check actual endpoints on both dates, including bookings beginning after
  // midnight. A reschedule may overlap its own authenticated reservation.
  const bookings = [
    ...listBookings(state.date!),
    ...listBookings(instantToLocal(times.endsAt).slice(0, 10)),
  ];
  return COURTS.map((court) => court.id)
    .sort((a, b) => a - b)
    .filter(
      (court) =>
        !bookings.some(
          (booking) =>
            booking.id !== excluding &&
            booking.status === "confirmed" &&
            booking.courtId === court &&
            Date.parse(booking.startsAt) < Date.parse(times.endsAt) &&
            Date.parse(booking.endsAt) > Date.parse(times.startsAt),
        ),
    );
}

function advanceSchedule(
  callSid: string,
  state: VoiceState,
  prefix = "",
): string {
  const next = { ...state, court: undefined };
  if (!next.date) return respond(callSid, { ...next, step: "date" }, prefix);
  try {
    validateDate(next.date);
  } catch (error) {
    return respond(
      callSid,
      { ...next, date: undefined, step: "date" },
      `${channelError(error)}。`,
    );
  }
  if (next.date < todayLocal())
    return respond(
      callSid,
      { ...next, date: undefined, step: "date" },
      "只能预约未来的时间，请换个日期。",
    );
  if (next.action === "query") {
    if (!next.duration)
      return respond(callSid, { ...next, step: "duration" }, prefix);
    return menu(callSid, availabilityReply(next.date, next.duration));
  }
  if (!next.hour) return respond(callSid, { ...next, step: "hour" }, prefix);
  if (!next.duration)
    return respond(callSid, { ...next, step: "duration" }, prefix);
  const court = availableCourts(next)[0];
  if (!court)
    return respond(
      callSid,
      { ...next, hour: undefined, step: "hour" },
      "这段时间已被预约，两个球场都没有完整空档，请换个开始时间。",
    );
  const assigned = { ...next, court };
  return respond(
    callSid,
    {
      ...assigned,
      step: !next.name ? "name" : !next.contactPhone ? "contact" : "confirm",
    },
    prefix,
  );
}

type SpokenSchedule = {
  fields: { hour?: string; duration?: number };
  invalid?: "hour" | "duration";
};

function scheduleSpeech(text: string): SpokenSchedule {
  // A bare digit in an hour answer is an hour, never an inferred duration.
  const hasDuration =
    /小时|小時|钟头|鐘頭|分钟|分鐘|hours?|\bh\b|默认|默認|default/i.test(text);
  const duration = hasDuration ? parseDurationSpeech(text) : null;
  if (hasDuration && !duration) return { fields: {}, invalid: "duration" };
  const hourText = duration
    ? text.replace(
        /[0-9零〇○一壹幺二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟]+(?:个|個)?(?:小时|小時|钟头|鐘頭|hours?|h)(?![a-z])/gi,
        "",
      )
    : text;
  const hour = parseHourSpeech(hourText);
  const hasHour =
    /[0-9零〇○一壹幺二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟]+(?:点|點|时|時)|\d{1,2}:\d{2}|凌晨|午夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚間|\b(?:am|pm)\b/i.test(
      hourText,
    );
  if (hasHour && !hour) return { fields: {}, invalid: "hour" };
  return {
    fields: {
      ...(hour ? { hour } : {}),
      ...(duration ? { duration } : {}),
    },
  };
}

function clarifySchedule(
  callSid: string,
  state: VoiceState,
  invalid: "hour" | "duration",
) {
  // A rejected correction must not fall back to the old time or duration.
  return respond(
    callSid,
    {
      ...state,
      hour: undefined,
      court: undefined,
      ...(invalid === "duration" ? { duration: undefined } : {}),
      step: state.date ? "hour" : "date",
    },
    invalid === "duration"
      ? "时长为一至八个整小时，请再说开始时间和时长。"
      : "只支持一个整点开始时间，请重新说明。",
  );
}

/** Model output is a proposal for the pending form, never a command to write. */
function applyVoiceInterpretation(
  callSid: string,
  state: VoiceState,
  text: string,
  interpretation: BookingInterpretation,
): string | null {
  if (interpretation.scope === "off_topic")
    return respond(
      callSid,
      state,
      "我只能帮助查询、创建、修改或取消网球场预约。我们继续处理您的预约。 ",
    );
  if (interpretation.scope !== "booking") return null;
  let next = { ...state };
  if (state.step === "menu") {
    const action = parseIntent(text) || interpretation.action;
    if (
      !action ||
      !["query", "book", "change", "cancel", "view"].includes(action)
    )
      return null;
    next = {
      turn: "",
      action,
      step: ["query", "book"].includes(action) ? "date" : "id",
    };
    if (next.step === "id") return respond(callSid, next);
  }
  if (!["query", "book", "change"].includes(next.action || "")) return null;
  const supplied = [
    interpretation.date,
    interpretation.hour,
    interpretation.duration,
    interpretation.name,
  ].some((value) => value !== null && value !== undefined);
  if (
    !supplied &&
    (!interpretation.correction || interpretation.correction === "court") &&
    state.step !== "menu"
  )
    return null;

  const correction = interpretation.correction;
  if (correction && correction !== "court") {
    const field = correction === "contact" ? "contactPhone" : correction;
    delete next[field];
    if (correction === "contact") delete next.contactUsesCallerNumber;
  }
  // Validate again at the application boundary, even when the shared client has
  // already checked its JSON schema.
  try {
    if (interpretation.date !== null && interpretation.date !== undefined)
      next.date = validateDate(interpretation.date);
    // The server assigns a court after checking the entire requested interval.
    // A caller/model court field never controls allocation or adds a question.
    if (interpretation.hour !== null && interpretation.hour !== undefined) {
      if (!/^([01]\d|2[0-3])$/.test(interpretation.hour))
        throw new AppError("只支持整点开始，请提供00至23的小时");
      next.hour = interpretation.hour;
    }
    if (
      interpretation.duration !== null &&
      interpretation.duration !== undefined
    )
      next.duration = validateDuration(interpretation.duration);
    if (interpretation.name !== null && interpretation.name !== undefined) {
      const name = parseNameSpeech(`我叫${interpretation.name}`);
      if (!name) throw new AppError("请只告诉我预约人的姓名");
      next.name = name;
    }
  } catch (error) {
    return respond(
      callSid,
      state,
      `${channelError(error)}。请重新回答当前问题。 `,
    );
  }
  return advanceSchedule(callSid, next);
}
function spokenNumber(value: string) {
  const normalized = value.replace(
    /[零〇一幺二两三四五六七八九]/g,
    (char) =>
      ({
        零: "0",
        〇: "0",
        一: "1",
        幺: "1",
        二: "2",
        两: "2",
        三: "3",
        四: "4",
        五: "5",
        六: "6",
        七: "7",
        八: "8",
        九: "9",
      })[char]!,
  );
  return normalized
    .replace(/^(我的)?(预约)?(编号|管理码|验证码)(是|为)?/, "")
    .replace(/[\s，,。.!！-]/g, "");
}

export function handleVoice(
  callSid: string,
  phone: string,
  turn: string | null,
  digits: string,
  speech = "",
  interpretation: BookingInterpretation | null = null,
) {
  if (!turn)
    return digits.trim() || speech.trim()
      ? recoverVoiceTurn(callSid)
      : menu(callSid);
  let state = currentVoiceState(callSid);
  if (!state) return menu(callSid, "会话已过期，请重新开始。 ");
  if (state.turn !== turn) return recoverVoiceTurn(callSid);
  const text = stripSpeech(speech);
  if (EXIT.test(text)) {
    setChannelState(`voice:${callSid}`, null);
    return `${say("本次操作已结束，未提交新的预约。感谢来电。 ")}<Hangup/>`;
  }
  if (isOffTopic(text))
    return respond(
      callSid,
      state,
      "我只能帮助查询、创建、修改或取消网球场预约。我们继续处理您的预约。 ",
    );
  if (!text && !digits && state.step !== "duration") {
    const silences = (state.silences || 0) + 1;
    if (silences >= 3) {
      setChannelState(`voice:${callSid}`, null);
      return `${say("暂时没有听到您的回答，本次操作未提交。您可以稍后再次来电。 ")}<Hangup/>`;
    }
    return respond(
      callSid,
      { ...state, silences },
      "没有听清，请再说一次，也可以使用按键。 ",
    );
  }
  state = { ...state, silences: 0 };
  try {
    if (interpretation && voiceAIContext(callSid, turn, digits, speech)) {
      const response = applyVoiceInterpretation(
        callSid,
        state,
        text,
        interpretation,
      );
      if (response !== null) return response;
    }
    switch (state.step) {
      case "menu": {
        const action =
          (
            {
              "1": "query",
              "2": "book",
              "3": "change",
              "4": "cancel",
              "5": "view",
            } as Record<string, Action>
          )[digits] || parseIntent(text);
        if (!action)
          return respond(
            callSid,
            state,
            "这里只处理球场预约，请说明您要查询、预订、修改还是取消。 ",
          );
        const next: VoiceState = {
          turn: "",
          action,
          step: ["query", "book"].includes(action) ? "date" : "id",
        };
        if (action === "query" || action === "book") {
          const date = parseCalendarDate(text);
          if (date) {
            const supplied = scheduleSpeech(text);
            if (supplied.invalid)
              return clarifySchedule(
                callSid,
                { ...next, date },
                supplied.invalid,
              );
            return advanceSchedule(callSid, {
              ...next,
              ...supplied.fields,
              date,
            });
          }
        }
        return respond(callSid, next);
      }
      case "date": {
        const date = /^\d{8}$/.test(digits)
          ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
          : parseCalendarDate(text);
        if (!date)
          return respond(
            callSid,
            state,
            "请说出一个有效日期，或输入八位日期。 ",
          );
        const supplied = scheduleSpeech(text);
        if (supplied.invalid)
          return clarifySchedule(callSid, { ...state, date }, supplied.invalid);
        return advanceSchedule(callSid, {
          ...state,
          ...supplied.fields,
          date,
        });
      }
      case "court": {
        return advanceSchedule(callSid, {
          ...state,
          court: undefined,
          hour: undefined,
        });
      }
      case "hour": {
        const supplied = scheduleSpeech(text);
        if (supplied.invalid)
          return clarifySchedule(callSid, state, supplied.invalid);
        const hour = /^([01]\d|2[0-3])$/.test(digits)
          ? digits
          : supplied.fields.hour;
        if (!hour)
          return respond(
            callSid,
            state,
            "只支持整点开始，请说例如下午三点，或输入00至23。 ",
          );
        return advanceSchedule(callSid, { ...state, ...supplied.fields, hour });
      }
      case "duration": {
        const duration = digits
          ? Number(digits)
          : text
            ? parseDurationSpeech(text)
            : 2;
        if (
          !duration ||
          !Number.isInteger(duration) ||
          duration < 1 ||
          duration > 8
        )
          return respond(callSid, state, "时长为一至八个整小时，默认两小时。 ");
        return advanceSchedule(callSid, { ...state, duration });
      }
      case "name": {
        const name = parseNameSpeech(text);
        if (!name)
          return respond(
            callSid,
            state,
            "请只告诉我预约人的姓名，例如我叫张三。 ",
          );
        return advanceSchedule(callSid, {
          ...state,
          name,
        });
      }
      case "contact": {
        const contactUsesCallerNumber =
          digits === "1" || usesCallerNumber(text);
        const contactPhone = contactUsesCallerNumber
          ? phone
          : parsePhoneSpeech(digits || text);
        if (!contactPhone)
          return respond(
            callSid,
            state,
            "联系电话未听清。您可以说使用来电号码，或用按键输入联系电话后按井号。 ",
          );
        return advanceSchedule(callSid, {
          ...state,
          contactPhone,
          contactUsesCallerNumber,
        });
      }
      case "id": {
        const id = digits || spokenNumber(text);
        if (!/^\d{8}$/.test(id))
          return respond(callSid, state, "预约编号必须是八位数字。 ");
        return respond(callSid, { ...state, id, step: "code" });
      }
      case "code": {
        const code = digits || spokenNumber(text);
        if (!/^\d{10}$/.test(code))
          return respond(callSid, state, "管理码必须是十位数字。 ");
        const next = { ...state, code };
        const booking = originalBooking(next);
        if (state.action === "view")
          return menu(
            callSid,
            `${booking.status === "cancelled" ? "预约已取消。" : "预约已确认。"}${spokenBookingSummary(booking)}`,
          );
        if (booking.status === "cancelled")
          return menu(callSid, "此预约已取消。 ");
        return respond(callSid, {
          ...next,
          name: booking.customerName,
          contactPhone: booking.phone,
          version: booking.version,
          step: state.action === "cancel" ? "confirm" : "date",
        });
      }
      case "confirm": {
        const corrections: [RegExp, Step][] = [
          [/修改日期|更改日期/, "date"],
          [/修改时间|更改时间/, "hour"],
          [/修改时长|更改时长|修改時長|更改時長/, "duration"],
          [/修改姓名|更改姓名/, "name"],
          [/修改电话|更改电话|修改联系/, "contact"],
        ];
        const correction =
          state.action !== "cancel" &&
          corrections.find(([pattern]) => pattern.test(text));
        if (correction)
          return respond(callSid, {
            ...state,
            court: undefined,
            step: correction[1],
          });
        if (
          state.action !== "cancel" &&
          /修改场地|更换场地|更改球场|修改場地|更換場地|更改球場/.test(text)
        )
          return advanceSchedule(
            callSid,
            state,
            "球场会按空档自动安排，请核对。 ",
          );
        const confirmation =
          digits === "1"
            ? "confirm"
            : digits === "2"
              ? "reject"
              : explicitConfirmation(text);
        if (confirmation === "reject")
          return menu(callSid, "没有提交更改。您可以重新开始预约。 ");
        if (confirmation !== "confirm")
          return respond(
            callSid,
            state,
            "尚未收到明确确认，预约还没有提交。请说确认预约，或按1确认。 ",
          );
        if (state.action === "cancel")
          return menu(
            callSid,
            `已取消。${spokenBookingSummary(cancelBooking(state.id!, state.version!, state.code!))}`,
          );
        // A review is tied to its displayed court. If it was taken while the
        // caller considered the summary, assign again and require a new turn's
        // explicit confirmation before writing anything.
        if (!state.date || !state.hour || !state.duration)
          return advanceSchedule(callSid, state);
        const open = availableCourts(state);
        if (!state.court || !open.includes(state.court))
          return advanceSchedule(
            callSid,
            state,
            "刚才的场地已被预约，已重新安排，请再次核对。 ",
          );
        if (state.action === "change") {
          const existing = originalBooking(state);
          const changed = updateBooking(
            existing.id,
            {
              courtId: state.court!,
              startLocal: `${state.date}T${state.hour}:00`,
              durationHours: state.duration,
              customerName: state.name || existing.customerName,
              phone: state.contactPhone || existing.phone,
              email: existing.email,
              version: state.version!,
              source: existing.source,
            },
            state.code,
          );
          return menu(callSid, `已修改。${spokenBookingSummary(changed)}`);
        }
        if (!state.name || !state.contactPhone)
          return respond(
            callSid,
            { ...state, step: state.name ? "contact" : "name" },
            "还需补齐预约人信息。 ",
          );
        const result = createBooking({
          courtId: state.court!,
          startLocal: `${state.date}T${state.hour}:00`,
          durationHours: state.duration || 2,
          customerName: state.name,
          phone: state.contactPhone,
          source: "phone",
        });
        if (queuePhoneBookingSms(callSid, result))
          return menu(callSid, phoneSmsPendingPrompt(result.booking.id));
        return menu(
          callSid,
          `预约成功。${spokenBookingSummary(result.booking)}短信暂不可用，请记下预约编号：${spokenAccessCode(result.booking.id)}。管理码：${spokenAccessCode(result.accessCode)}。`,
        );
      }
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      error.status === 409 &&
      ["book", "change"].includes(state.action || "") &&
      /时间段已被预约/.test(error.message) &&
      state.date &&
      state.hour &&
      state.duration
    ) {
      return advanceSchedule(
        callSid,
        state,
        "刚才的场地已被预约，已重新安排，请再次核对。 ",
      );
    }
    return menu(callSid, channelError(error));
  }
}
