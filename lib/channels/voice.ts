import { randomUUID } from "node:crypto";
import type { Booking } from "@/lib/domain";
import { TIME_ZONE } from "@/lib/domain";
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
import { availabilityReply, bookingSummary } from "./commands";
import { baseUrl, channelError, escapeXml } from "./security";
import { VOICE_CAPTURE } from "./voice-capture";
import {
  explicitConfirmation,
  isOffTopic,
  parseCalendarDate,
  parseCourtSpeech,
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
function spokenDigits(value: string) {
  return value.split("").join("，");
}
function stateSummary(state: VoiceState) {
  const times = bookingTimes(
    `${state.date}T${state.hour}:00`,
    state.duration,
    false,
  );
  const format = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${state.court}号球场，悉尼时间${format.format(new Date(times.startsAt))}开始，${format.format(new Date(times.endsAt))}结束，共${state.duration}小时。`;
}
function prompt(state: VoiceState): string {
  switch (state.step) {
    case "menu":
      return `${state.introduced ? "" : "欢迎使用网球场预约助手。我只处理球场预约。所有时间均为悉尼时间。"}请告诉我您想预定球场、查询空闲时间、修改还是取消预约。也可以按1查询，按2预订，按3修改，按4取消，按5查看。`;
    case "date":
      return "您希望哪一天使用球场？可以说具体日期、明天或后天，也可以输入八位日期。";
    case "court":
      return state.action === "query"
        ? "您想查询一号球场、二号球场，还是两个球场？也可以按0查询全部。"
        : "请从刚才公布的可用场地中选择一号球场或二号球场。";
    case "hour":
      return `您希望几点开始？请说整点，例如下午三点或晚上十一点，也可以输入00至23的两位小时。每次默认${state.duration || 2}小时，可以跨午夜。`;
    case "duration":
      return "您想预订几个小时？默认两小时，可以说默认或两个小时，也可输入1至8，直接按井号使用默认两小时。";
    case "name":
      return "请告诉我预约人的姓名，例如我叫张三。姓名将公开展示在网站日程中，联系电话不会公开。";
    case "contact":
      return "请提供联系电话。若使用当前来电号码，请说使用来电号码，或按1；也可以直接说出或输入其他联系电话，输入完按井号。";
    case "id":
      return "请说出或输入八位预约编号。";
    case "code":
      return "请说出或输入十位预约管理码。管理码用于验证您有权管理这次预约。";
    case "confirm":
      return state.action === "cancel"
        ? `即将取消预约${spokenDigits(state.id!)}。确认取消请说确认取消或按1，返回请说不确认或按2。`
        : `${state.action === "change" ? "即将修改预约。" : "请核对，姓名将公开展示。"}预约人${state.name}，联系电话${spokenDigits(state.contactPhone || "")}。${stateSummary(state)}确认无误请说确认预约或按1。需要调整可说修改日期、修改场地、修改时间、修改姓名或修改电话；不确认请说不确认或按2。`;
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
  const next = { ...state, turn: randomUUID(), introduced: true };
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
    return state;
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
function hasOpenSlot(state: VoiceState, court = state.court) {
  const availability = getAvailability(state.date!, state.duration || 2);
  return availability.slots.some(
    (slot) =>
      (!court || slot.courtId === court) &&
      slot.available &&
      (!state.hour || slot.startLocal.endsWith(`T${state.hour}:00`)),
  );
}
function afterDate(callSid: string, state: VoiceState, date: string) {
  const next = { ...state, date };
  const availability = getAvailability(date, state.duration || 2);
  if (
    date < todayLocal() ||
    !availability.slots.some((slot) => slot.available)
  ) {
    return respond(
      callSid,
      { ...next, step: "date" },
      "这一天没有可预订的未来时段，请换一个日期。 ",
    );
  }
  const nextStep: Step = next.court
    ? next.hour
      ? "duration"
      : "hour"
    : "court";
  return respond(
    callSid,
    { ...next, step: nextStep },
    availabilityReply(date, 0, state.duration || 2),
  );
}

function availableAISchedule(state: VoiceState): boolean {
  if (state.action !== "change") return hasOpenSlot(state);
  // A reschedule may overlap its own reservation. Read both local dates so a
  // booking crossing midnight is checked against every other real reservation.
  const times = bookingTimes(`${state.date}T${state.hour}:00`, state.duration);
  originalBooking(state);
  const bookings = [
    ...listBookings(state.date!),
    ...listBookings(instantToLocal(times.endsAt).slice(0, 10)),
  ];
  return !bookings.some(
    (booking) =>
      booking.id !== state.id &&
      booking.status === "confirmed" &&
      booking.courtId === state.court &&
      Date.parse(booking.startsAt) < Date.parse(times.endsAt) &&
      Date.parse(booking.endsAt) > Date.parse(times.startsAt),
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
    interpretation.court,
    interpretation.hour,
    interpretation.duration,
    interpretation.name,
  ].some((value) => value !== null && value !== undefined);
  if (!supplied && !interpretation.correction && state.step !== "menu")
    return null;

  const correction = interpretation.correction;
  if (correction) {
    const field = correction === "contact" ? "contactPhone" : correction;
    delete next[field];
  }
  // Validate again at the application boundary, even when the shared client has
  // already checked its JSON schema.
  try {
    if (interpretation.date !== null && interpretation.date !== undefined)
      next.date = validateDate(interpretation.date);
    if (interpretation.court !== null && interpretation.court !== undefined) {
      if (
        !(next.action === "query" ? [0, 1, 2] : [1, 2]).includes(
          interpretation.court,
        )
      )
        throw new AppError("请选择一号或二号球场");
      next.court = interpretation.court;
    }
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
  if (!next.date) return respond(callSid, { ...next, step: "date" });
  const availability = getAvailability(next.date, next.duration || 2);
  if (
    next.date < todayLocal() ||
    !availability.slots.some((slot) => slot.available)
  )
    return respond(
      callSid,
      { ...next, date: undefined, step: "date" },
      "这一天没有可预订的未来时段，请换一个日期。 ",
    );
  if (next.court === undefined)
    return respond(
      callSid,
      { ...next, step: "court" },
      availabilityReply(next.date, 0, next.duration || 2),
    );
  if (next.action === "query") {
    if (!next.duration) return respond(callSid, { ...next, step: "duration" });
    return menu(
      callSid,
      availabilityReply(next.date, next.court, next.duration),
    );
  }
  if (!next.hour) return respond(callSid, { ...next, step: "hour" });
  bookingTimes(`${next.date}T${next.hour}:00`, next.duration || 2);
  if (!availableAISchedule(next))
    return respond(
      callSid,
      { ...next, hour: undefined, step: "hour" },
      `所选场地、开始时间或时长暂无空档。${availabilityReply(next.date, next.court, next.duration || 2)}`,
    );
  if (!next.duration) return respond(callSid, { ...next, step: "duration" });
  if (!next.name) return respond(callSid, { ...next, step: "name" });
  if (!next.contactPhone) return respond(callSid, { ...next, step: "contact" });
  return respond(
    callSid,
    { ...next, step: "confirm" },
    "已更新待确认的信息，尚未提交。 ",
  );
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
            next.hour = parseHourSpeech(text) || undefined;
            const court = parseCourtSpeech(text);
            next.court = court === 1 || court === 2 ? court : undefined;
            return afterDate(callSid, next, date);
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
        return afterDate(callSid, state, date);
      }
      case "court": {
        const court = /^\d$/.test(digits)
          ? Number(digits)
          : parseCourtSpeech(text);
        if (
          court === null ||
          !(state.action === "query" ? [0, 1, 2] : [1, 2]).includes(court)
        )
          return respond(callSid, state, "请选择一号或二号球场。 ");
        const next = { ...state, court };
        if (state.action === "book" && !hasOpenSlot(next)) {
          return respond(
            callSid,
            { ...next, court: undefined, hour: undefined },
            `您选择的场地或时间暂无空档。${availabilityReply(state.date!, 0, state.duration || 2)}`,
          );
        }
        return respond(callSid, {
          ...next,
          step:
            state.action === "query"
              ? "duration"
              : state.hour
                ? "duration"
                : "hour",
        });
      }
      case "hour": {
        const hour = /^([01]\d|2[0-3])$/.test(digits)
          ? digits
          : parseHourSpeech(text);
        if (!hour)
          return respond(
            callSid,
            state,
            "只支持整点开始，请说例如下午三点，或输入00至23。 ",
          );
        const next = { ...state, hour };
        if (state.action === "book" && !hasOpenSlot(next)) {
          return respond(
            callSid,
            state,
            `这个开始时间不可预订。${availabilityReply(state.date!, state.court!, state.duration || 2)}`,
          );
        }
        return respond(callSid, { ...next, step: "duration" });
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
        const next = { ...state, duration };
        if (state.action === "query")
          return menu(
            callSid,
            availabilityReply(state.date!, state.court!, duration),
          );
        if (state.action === "book" && !hasOpenSlot(next)) {
          return respond(
            callSid,
            { ...next, step: "hour", hour: undefined },
            `所选时长无法完整预订。${availabilityReply(state.date!, state.court!, duration)}`,
          );
        }
        return respond(callSid, {
          ...next,
          step:
            state.action === "book"
              ? state.name
                ? state.contactPhone
                  ? "confirm"
                  : "contact"
                : "name"
              : state.contactPhone
                ? "confirm"
                : "contact",
        });
      }
      case "name": {
        const name = parseNameSpeech(text);
        if (!name)
          return respond(
            callSid,
            state,
            "请只告诉我预约人的姓名，例如我叫张三。 ",
          );
        return respond(callSid, {
          ...state,
          name,
          step: state.contactPhone ? "confirm" : "contact",
        });
      }
      case "contact": {
        const contactPhone =
          digits === "1" || usesCallerNumber(text)
            ? phone
            : parsePhoneSpeech(digits || text);
        if (!contactPhone)
          return respond(
            callSid,
            state,
            "联系电话未听清。您可以说使用来电号码，或用按键输入联系电话后按井号。 ",
          );
        return respond(callSid, { ...state, contactPhone, step: "confirm" });
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
          return menu(callSid, bookingSummary(booking));
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
          [/修改场地|更换场地|更改球场/, "court"],
          [/修改时间|更改时间/, "hour"],
          [/修改姓名|更改姓名/, "name"],
          [/修改电话|更改电话|修改联系/, "contact"],
        ];
        const correction =
          state.action !== "cancel" &&
          corrections.find(([pattern]) => pattern.test(text));
        if (correction)
          return respond(callSid, { ...state, step: correction[1] });
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
            bookingSummary(
              cancelBooking(state.id!, state.version!, state.code!),
            ),
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
          return menu(callSid, bookingSummary(changed));
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
        const reference = spokenDigits(result.booking.id),
          code = spokenDigits(result.accessCode);
        return menu(
          callSid,
          `${bookingSummary(result.booking)}网站日程已更新。请记下预约编号：${reference}。管理码：${code}。再次播报，预约编号：${reference}。管理码：${code}。请妥善保管。`,
        );
      }
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      error.status === 409 &&
      state.action === "book" &&
      state.date
    ) {
      return respond(
        callSid,
        { ...state, step: "hour", hour: undefined },
        `${channelError(error)}。${availabilityReply(state.date, state.court || 0, state.duration || 2)}`,
      );
    }
    return menu(callSid, channelError(error));
  }
}
