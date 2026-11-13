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
  parseSpokenDigits,
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

const EXIT =
  /^(不预约了|不预订了|退出|结束通话|挂断|再见|算了|goodbye|bye|hang up|end (?:the )?call|exit)$/i;

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
    /电话|電話|联系|聯繫|管理码|管理碼|验证码|驗證碼|预约编号|預約編號|邮箱|郵箱|@|\b(?:phone|contact|calling number|caller id|management code|access code|booking (?:reference|number|id)|email)\b/i.test(
      text,
    ) ||
    /(?:[0-9零〇一幺二两三四五六七八九][\s，,-]*){7,}/.test(withoutDates) ||
    /(?:\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b[\s,.-]*){7,}/i.test(
      withoutDates,
    )
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
  return `<Say language="en-AU" voice="Polly.Olivia-Neural">${escapeXml(text)}</Say>`;
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
        ? "Would you like to book a court or check availability?"
        : "Hello. Would you like to book a court or check availability?";
    case "date":
      return state.action === "query"
        ? "Which date would you like to check?"
        : "Which date would you like to book?";
    case "court":
      return "What time would you like to start? Please use a whole hour.";
    case "hour":
      return "What time would you like to start? Please use a whole hour.";
    case "duration":
      return state.action === "query"
        ? "How many hours would you like to check? The default is two hours."
        : "How many hours would you like to book? The default is two hours.";
    case "name":
      return "What is the booking name? Your name will appear publicly on the website schedule.";
    case "contact":
      return "What is your contact number? Say use my calling number, or press 1 to use the number you are calling from.";
    case "id":
      return "Please say your eight digit booking reference, or enter it on the keypad.";
    case "code":
      return "Please say your ten digit access code, or enter it on the keypad.";
    case "confirm":
      return state.action === "cancel"
        ? `Cancel this booking: ${spokenBookingSummary(originalBooking(state))} Say confirm cancellation or press 1. To keep it, say do not confirm or press 2.`
        : `${state.action === "change" ? "Change the booking to: " : "Please review: "}${state.namePrivacyNoticeGiven ? "" : "Your name will appear publicly on the website schedule. "}Booking name: ${state.name}. Contact number: ${state.contactUsesCallerNumber ? "the number you are calling from" : spokenAccessCode(state.contactPhone || "")}. ${stateSummary(state)} Say confirm booking or press 1 to confirm. To make a change, tell me what to change. To stop, say do not confirm or press 2.`;
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
    return menu(
      callSid,
      "This session was interrupted. No new changes have been submitted. Please choose again. ",
    );
  return renderGather(
    { ...state, introduced: true },
    "I did not receive that answer. Please answer the current question again. No new changes have been submitted. ",
  );
}
function originalBooking(state: VoiceState): Booking {
  return getBooking(state.id!, state.code!);
}
function availabilityReply(date: string, duration = 2): string {
  const availability = getAvailability(date, duration);
  const lines = [
    `Available start times for ${spokenDate(date)}, Sydney time, for ${spokenDuration(duration)}. `,
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
      .join(", ");
    lines.push(`Court ${item.id}: ${starts || "no available start times"}. `);
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
      `${channelError(error)} `,
    );
  }
  if (next.date < todayLocal())
    return respond(
      callSid,
      { ...next, date: undefined, step: "date" },
      "Bookings must be in the future. Please choose another date. ",
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
      "Neither court is available for the full booking. Please choose another start time. ",
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
    ? text
        .replace(
          /[0-9零〇○一壹幺二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟]+(?:个|個)?(?:小时|小時|钟头|鐘頭|hours?|h)(?![a-z])/gi,
          "",
        )
        .replace(
          /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(?:hours?|h)\b/gi,
          "",
        )
    : text;
  // A court number immediately after a spoken hour is not a minute, such as
  // 三点二号场. Remove only explicit court phrases from the parsing copy.
  const clockText = hourText.replace(
    /(?:第)?[一壹二贰貳两兩12](?:号|號|个|個)?(?:球场|球場|场地|場地|场|場)/g,
    "",
  );
  const hour = parseHourSpeech(clockText);
  const hasHour =
    /[0-9零〇○一壹幺二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟]+(?:点|點|时|時)|\d{1,2}:\d{2}|凌晨|午夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚間|\b(?:[ap]\.?\s*m\.?|morning|afternoon|evening|noon|midnight|o['’]?clock)\b|\b(?:at|from)\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i.test(
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

function suppliedName(text: string): string | null {
  const phrase =
    text.match(
      /(?:my name is|i(?:'m| am))\s+([A-Za-z][A-Za-z' -]{0,59})\s*$/i,
    )?.[0] ||
    text.match(/(?:我叫|我的名字是|我的姓名是)[\p{Script=Han}·]{2,16}$/u)?.[0];
  return phrase ? parseNameSpeech(phrase) : null;
}

function suppliedDate(text: string): boolean {
  return /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{8}|年|月|明天|明日|今天|今日|后天|後天|周|週|星期|礼拜|禮拜|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/i.test(
    text,
  );
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
      ? "Bookings must last one to eight whole hours. Please tell me the start time and duration again. "
      : "Please give one whole hour start time. ",
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
      "I can only help check, create, change or cancel tennis court bookings. Let us continue with your booking. ",
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
  // Names such as June First or John Noon can resemble scheduling answers.
  // At the name question, only validated model proposals may change a schedule.
  const rawSchedule: SpokenSchedule =
    state.step === "name" ? { fields: {} } : scheduleSpeech(text);
  if (rawSchedule.invalid)
    return clarifySchedule(callSid, next, rawSchedule.invalid);
  const rawDate = state.step === "name" ? null : parseCalendarDate(text);
  if (state.step !== "name" && suppliedDate(text) && !rawDate)
    return respond(
      callSid,
      { ...next, date: undefined, court: undefined, step: "date" },
      "Please give one valid, unambiguous date. ",
    );
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
  // A model may omit a field that the caller supplied alongside another one.
  // Keep deterministic fields rather than discarding part of that answer.
  if (!interpretation.date && rawDate) next.date = rawDate;
  if (!interpretation.hour && rawSchedule.fields.hour)
    next.hour = rawSchedule.fields.hour;
  if (!interpretation.duration && rawSchedule.fields.duration)
    next.duration = rawSchedule.fields.duration;
  if (!interpretation.name) next.name = suppliedName(text) || next.name;
  // Validate again at the application boundary, even when the shared client has
  // already checked its JSON schema.
  try {
    if (interpretation.date !== null && interpretation.date !== undefined)
      next.date = validateDate(interpretation.date);
    // The server assigns a court after checking the entire requested interval.
    // A caller/model court field never controls allocation or adds a question.
    if (interpretation.hour !== null && interpretation.hour !== undefined) {
      if (!/^([01]\d|2[0-3])$/.test(interpretation.hour))
        throw new AppError(
          "Please give a whole hour start time from 00 to 23.",
        );
      next.hour = interpretation.hour;
    }
    if (
      interpretation.duration !== null &&
      interpretation.duration !== undefined
    )
      next.duration = validateDuration(interpretation.duration);
    if (interpretation.name !== null && interpretation.name !== undefined) {
      const name = parseNameSpeech(`My name is ${interpretation.name}`);
      if (!name) throw new AppError("Please tell me only the booking name.");
      next.name = name;
    }
  } catch (error) {
    return respond(
      callSid,
      state,
      `${channelError(error)} Please answer the current question again. `,
    );
  }
  return advanceSchedule(callSid, next);
}
function spokenNumber(value: string) {
  return (
    parseSpokenDigits(
      value
        .replace(/^(我的)?(预约)?(编号|管理码|验证码)(是|为)?/, "")
        .replace(
          /^(?:(?:my|the)\s+)?(?:(?:booking|reservation)\s+(?:reference|number|id)|(?:management|access|verification)\s+code)(?:\s+is)?\s*[:：]?\s*/i,
          "",
        ),
    ) || ""
  );
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
  if (!state)
    return menu(callSid, "This session has expired. Please start again. ");
  if (state.turn !== turn) return recoverVoiceTurn(callSid);
  const text = stripSpeech(speech);
  if (EXIT.test(text)) {
    setChannelState(`voice:${callSid}`, null);
    return `${say("The call has ended. No new booking has been submitted. Thank you for calling. ")}<Hangup/>`;
  }
  if (isOffTopic(text))
    return respond(
      callSid,
      state,
      "I can only help check, create, change or cancel tennis court bookings. Let us continue with your booking. ",
    );
  if (!text && !digits && state.step !== "duration") {
    const silences = (state.silences || 0) + 1;
    if (silences >= 3) {
      setChannelState(`voice:${callSid}`, null);
      return `${say("I have not heard an answer. No changes have been submitted. Please call again later. ")}<Hangup/>`;
    }
    return respond(
      callSid,
      { ...state, silences },
      "I did not catch that. Please say it again, or use the keypad. ",
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
            "Please tell me whether you would like to check availability, book, change or cancel a court booking. ",
          );
        const next: VoiceState = {
          turn: "",
          action,
          step: ["query", "book"].includes(action) ? "date" : "id",
        };
        if (action === "query" || action === "book") {
          const date = parseCalendarDate(text);
          const supplied = scheduleSpeech(text);
          if (supplied.invalid)
            return clarifySchedule(
              callSid,
              { ...next, ...(date ? { date } : {}) },
              supplied.invalid,
            );
          const name = suppliedName(text);
          if (date) {
            return advanceSchedule(callSid, {
              ...next,
              ...supplied.fields,
              ...(name ? { name } : {}),
              date,
            });
          }
          return advanceSchedule(callSid, {
            ...next,
            ...supplied.fields,
            ...(name ? { name } : {}),
          });
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
            "Please say one valid date, or enter eight digits for the year, month and day. ",
          );
        const supplied = scheduleSpeech(text);
        if (supplied.invalid)
          return clarifySchedule(callSid, { ...state, date }, supplied.invalid);
        return advanceSchedule(callSid, {
          ...state,
          ...supplied.fields,
          ...(suppliedName(text) ? { name: suppliedName(text)! } : {}),
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
        const date = parseCalendarDate(text);
        if (suppliedDate(text) && !date)
          return respond(
            callSid,
            { ...state, date: undefined, court: undefined, step: "date" },
            "Please give one valid, unambiguous date. ",
          );
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
            "Please use a whole hour, such as three pm, or enter an hour from 00 to 23. ",
          );
        return advanceSchedule(callSid, {
          ...state,
          ...supplied.fields,
          ...(date ? { date } : {}),
          hour,
        });
      }
      case "duration": {
        const date = parseCalendarDate(text);
        if (suppliedDate(text) && !date)
          return respond(
            callSid,
            { ...state, date: undefined, court: undefined, step: "date" },
            "Please give one valid, unambiguous date. ",
          );
        const supplied = scheduleSpeech(text);
        if (supplied.invalid)
          return clarifySchedule(callSid, state, supplied.invalid);
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
          return respond(
            callSid,
            state,
            "Bookings must last one to eight whole hours. The default is two hours. ",
          );
        return advanceSchedule(callSid, {
          ...state,
          ...(supplied.fields.hour &&
          /点|點|时|時|\d{1,2}:\d{2}|\b(?:at|from|noon|midnight|morning|afternoon|evening)|\b[ap]\.?\s*m\.?/i.test(
            text,
          )
            ? { hour: supplied.fields.hour }
            : {}),
          ...(date ? { date } : {}),
          duration,
        });
      }
      case "name": {
        const name = parseNameSpeech(text);
        if (!name)
          return respond(
            callSid,
            state,
            "Please tell me only the booking name, for example, my name is John Smith. ",
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
            "I did not catch your contact number. Say use my calling number, or enter your contact number followed by the hash key. ",
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
          return respond(
            callSid,
            state,
            "The booking reference must contain eight digits. ",
          );
        return respond(callSid, { ...state, id, step: "code" });
      }
      case "code": {
        const code = digits || spokenNumber(text);
        if (!/^\d{10}$/.test(code))
          return respond(
            callSid,
            state,
            "The access code must contain ten digits. ",
          );
        const next = { ...state, code };
        const booking = originalBooking(next);
        if (state.action === "view")
          return menu(
            callSid,
            `${booking.status === "cancelled" ? "This booking is cancelled. " : "This booking is confirmed. "}${spokenBookingSummary(booking)}`,
          );
        if (booking.status === "cancelled")
          return menu(callSid, "This booking is already cancelled. ");
        return respond(callSid, {
          ...next,
          name: booking.customerName,
          contactPhone: booking.phone,
          version: booking.version,
          step: state.action === "cancel" ? "confirm" : "date",
        });
      }
      case "confirm": {
        const rawConfirmation = explicitConfirmation(text);
        if (rawConfirmation === "reject")
          return menu(
            callSid,
            "No changes have been submitted. You can start a new booking. ",
          );
        if (
          state.action !== "cancel" &&
          rawConfirmation !== "confirm" &&
          !digits
        ) {
          const supplied = scheduleSpeech(text);
          if (supplied.invalid)
            return clarifySchedule(callSid, state, supplied.invalid);
          const date = parseCalendarDate(text);
          if (suppliedDate(text) && !date)
            return respond(
              callSid,
              { ...state, date: undefined, court: undefined, step: "date" },
              "Please give one valid, unambiguous date. ",
            );
          const name = suppliedName(text);
          if (date || supplied.fields.hour || supplied.fields.duration || name)
            return advanceSchedule(callSid, {
              ...state,
              ...supplied.fields,
              ...(date ? { date } : {}),
              ...(name ? { name } : {}),
            });
        }
        const corrections: [RegExp, Step][] = [
          [
            /修改日期|更改日期|\b(?:change|correct|update)\s+(?:(?:the|my)\s+)?date\b/i,
            "date",
          ],
          [
            /修改时间|更改时间|\b(?:change|correct|update)\s+(?:(?:the|my)\s+)?(?:start )?time\b/i,
            "hour",
          ],
          [
            /修改时长|更改时长|修改時長|更改時長|\b(?:change|correct|update)\s+(?:(?:the|my)\s+)?duration\b/i,
            "duration",
          ],
          [
            /修改姓名|更改姓名|\b(?:change|correct|update)\s+(?:(?:the|my)\s+)?(?:booking )?name\b/i,
            "name",
          ],
          [
            /修改电话|更改电话|修改联系|\b(?:change|correct|update)\s+(?:(?:the|my)\s+)?(?:contact|phone|number)\b/i,
            "contact",
          ],
        ];
        const correction =
          state.action !== "cancel" &&
          corrections.find(([pattern]) => pattern.test(text));
        if (correction) {
          const next = {
            ...state,
            court: undefined,
            step: correction[1],
          };
          if (correction[1] === "date") delete next.date;
          if (correction[1] === "hour") delete next.hour;
          if (correction[1] === "duration") delete next.duration;
          if (correction[1] === "name") delete next.name;
          if (correction[1] === "contact") {
            delete next.contactPhone;
            delete next.contactUsesCallerNumber;
          }
          return respond(callSid, next);
        }
        if (
          state.action !== "cancel" &&
          /修改场地|更换场地|更改球场|修改場地|更換場地|更改球場|\b(?:change|switch|choose|use)\s+(?:(?:the|my|to)\s+)?(?:court|courts)\b/i.test(
            text,
          )
        )
          return advanceSchedule(
            callSid,
            state,
            "A court is assigned automatically based on availability. Please review the details. ",
          );
        const confirmation =
          digits === "1"
            ? "confirm"
            : digits === "2"
              ? "reject"
              : rawConfirmation;
        if (confirmation === "reject")
          return menu(
            callSid,
            "No changes have been submitted. You can start a new booking. ",
          );
        if (confirmation !== "confirm")
          return respond(
            callSid,
            state,
            "The booking has not been submitted. Please say confirm booking, or press 1 to confirm. ",
          );
        if (state.action === "cancel")
          return menu(
            callSid,
            `Booking cancelled. ${spokenBookingSummary(cancelBooking(state.id!, state.version!, state.code!))}`,
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
            "That court was just booked. I have checked availability again. Please review the updated details and confirm again. ",
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
          return menu(
            callSid,
            `Booking changed. ${spokenBookingSummary(changed)}`,
          );
        }
        if (!state.name || !state.contactPhone)
          return respond(
            callSid,
            { ...state, step: state.name ? "contact" : "name" },
            "Please provide the remaining booking details. ",
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
          `Booking confirmed. ${spokenBookingSummary(result.booking)} SMS is unavailable. Please write down your booking reference: ${spokenAccessCode(result.booking.id)}. Access code: ${spokenAccessCode(result.accessCode)}.`,
        );
      }
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      error.status === 409 &&
      ["book", "change"].includes(state.action || "") &&
      /That time slot is already booked\.|时间段已被预约/.test(error.message) &&
      state.date &&
      state.hour &&
      state.duration
    ) {
      return advanceSchedule(
        callSid,
        state,
        "That court was just booked. I have checked availability again. Please review the updated details and confirm again. ",
      );
    }
    return menu(callSid, channelError(error));
  }
}
