import { createHash, randomBytes } from "node:crypto";
import type { BookingInterpretation } from "./booking-ai";
import { baseUrl, escapeXml } from "./security";
import { handleVoice, voiceProgress } from "./voice";
import {
  AppError,
  getChannelEvent,
  getChannelState,
  rateLimit,
  runChannelEvent,
  setChannelState,
} from "@/lib/store";
import { validateDate } from "@/lib/time";

const TICKET_TTL = 120_000;
const SESSION_TTL = 3_600_000;
const SID = /^[A-Za-z0-9]{10,64}$/;
const INPUT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIONS = ["query", "book", "change", "cancel", "view"];
const CORRECTIONS = ["date", "court", "hour", "duration", "name", "contact"];
const INTERPRETATION_KEYS = [
  "scope",
  "action",
  "date",
  "court",
  "hour",
  "duration",
  "name",
  "correction",
];

type Ticket = {
  callSid: string;
  phone: string;
  expiresAt: number;
  streamSid?: string;
};
type Session = {
  callSid: string;
  phone: string;
  ticketHash: string;
  expiresAt: number;
  active: boolean;
  turn: string | null;
};
type RealtimeContext = {
  step?: string;
  action?: string;
  date?: string;
  court?: number;
  hour?: string;
  duration?: number;
};
export type RealtimeReply = {
  prompt: string;
  context: RealtimeContext;
  closed?: boolean;
};
type Start = {
  op: "start";
  callSid: string;
  streamSid: string;
  ticket: string;
};
type Turn = {
  op: "turn";
  callSid: string;
  streamSid: string;
  inputId: string;
  transcript: string;
  digits: string;
  interpretation: BookingInterpretation | null;
};
type Stop = { op: "stop"; callSid: string; streamSid: string };
type RealtimeRequest = Start | Turn | Stop;

export function realtimeVoiceEnabled(): boolean {
  return (
    process.env.VOICE_MODE === "realtime" &&
    Boolean(process.env.OPENAI_API_KEY?.trim()) &&
    Boolean(process.env.REALTIME_BRIDGE_SECRET?.trim())
  );
}

const ticketHash = (ticket: string) =>
  createHash("sha256").update(ticket).digest("hex");
const ticketKey = (hash: string) => `realtime:ticket:${hash}`;
const sessionKey = (streamSid: string) => `realtime:session:${streamSid}`;

/** Called only inside the signed Twilio webhook's idempotent initial event. */
export function createRealtimeVoice(callSid: string, phone: string): string {
  if (!realtimeVoiceEnabled())
    throw new AppError("Realtime phone service is not configured", 503);
  if (!SID.test(callSid) || !/^\+\d{7,15}$/.test(phone))
    throw new AppError("Invalid call information", 400);
  const origin = new URL(baseUrl());
  origin.protocol = "wss:";
  origin.pathname = "/api/realtime/voice";
  const ticket = randomBytes(32).toString("hex");
  setChannelState(
    ticketKey(ticketHash(ticket)),
    JSON.stringify({
      callSid,
      phone,
      expiresAt: Date.now() + TICKET_TTL,
    } satisfies Ticket),
    TICKET_TTL,
  );
  return `<Connect><Stream url="${escapeXml(origin.toString())}"><Parameter name="ticket" value="${ticket}"/></Stream></Connect><Say language="en-AU" voice="Polly.Olivia-Neural">This call has ended. If you missed the result, please check your booking on the website before submitting again. You can also call back to check.</Say><Hangup/>`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("Request body must be an object", 400);
  return value as Record<string, unknown>;
}

function interpretation(
  value: unknown,
  transcript: string,
): BookingInterpretation | null {
  if (value === null || value === undefined) return null;
  const item = object(value);
  const invalid = () => {
    throw new AppError("Invalid booking fields", 400);
  };
  if (
    Object.keys(item).length !== INTERPRETATION_KEYS.length ||
    INTERPRETATION_KEYS.some((key) => !Object.hasOwn(item, key))
  )
    invalid();
  if (
    typeof item.scope !== "string" ||
    !["booking", "off_topic", "unclear"].includes(item.scope) ||
    (item.action !== null &&
      (typeof item.action !== "string" || !ACTIONS.includes(item.action))) ||
    (item.correction !== null &&
      (typeof item.correction !== "string" ||
        !CORRECTIONS.includes(item.correction)))
  )
    invalid();
  if (item.date !== null) validateDate(item.date);
  if (
    item.court !== null &&
    (typeof item.court !== "number" || ![0, 1, 2].includes(item.court))
  )
    invalid();
  if (
    item.hour !== null &&
    (typeof item.hour !== "string" || !/^(?:[01]\d|2[0-3])$/.test(item.hour))
  )
    invalid();
  if (
    item.duration !== null &&
    (typeof item.duration !== "number" ||
      !Number.isInteger(item.duration) ||
      item.duration < 1 ||
      item.duration > 8)
  )
    invalid();
  if (
    item.name !== null &&
    (typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 80 ||
      /[\x00-\x1f<>]/.test(item.name) ||
      !transcript.normalize("NFKC").includes(item.name.normalize("NFKC")))
  )
    invalid();
  return item as BookingInterpretation;
}

/** Neither model tool arguments nor arbitrary extra fields become raw input. */
export function parseRealtimeRequest(value: unknown): RealtimeRequest {
  const item = object(value);
  if (
    typeof item.callSid !== "string" ||
    !SID.test(item.callSid) ||
    typeof item.streamSid !== "string" ||
    !SID.test(item.streamSid)
  )
    throw new AppError("Invalid call or audio stream ID", 400);
  const common = { callSid: item.callSid, streamSid: item.streamSid };
  let keys: string[];
  let parsed: RealtimeRequest;
  if (item.op === "start") {
    keys = ["op", "callSid", "streamSid", "ticket"];
    if (typeof item.ticket !== "string" || !/^[a-f0-9]{64}$/.test(item.ticket))
      throw new AppError("Invalid call credentials", 400);
    parsed = { op: "start", ...common, ticket: item.ticket };
  } else if (item.op === "turn") {
    keys = [
      "op",
      "callSid",
      "streamSid",
      "inputId",
      "transcript",
      "digits",
      "interpretation",
    ];
    if (
      typeof item.inputId !== "string" ||
      !INPUT_ID.test(item.inputId) ||
      typeof item.transcript !== "string" ||
      item.transcript.length > 4_096 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.transcript) ||
      (item.digits !== undefined &&
        (typeof item.digits !== "string" ||
          !/^[0-9*#]{0,32}$/.test(item.digits)))
    )
      throw new AppError("Invalid call input", 400);
    parsed = {
      op: "turn",
      ...common,
      inputId: item.inputId,
      transcript: item.transcript,
      digits: (item.digits as string | undefined) || "",
      interpretation: interpretation(item.interpretation, item.transcript),
    };
  } else if (item.op === "stop") {
    keys = ["op", "callSid", "streamSid"];
    parsed = { op: "stop", ...common };
  } else throw new AppError("Invalid call operation", 400);
  if (Object.keys(item).some((key) => !keys.includes(key)))
    throw new AppError("Unknown call field", 400);
  return parsed;
}

function readState<T>(key: string): T | null {
  const saved = getChannelState(key);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as T;
  } catch {
    return null;
  }
}

function session(request: RealtimeRequest, allowStopped = false): Session {
  const saved = readState<Session>(sessionKey(request.streamSid));
  if (saved && saved.callSid !== request.callSid)
    throw new AppError("Call does not match the audio stream", 403);
  if (
    !saved ||
    saved.expiresAt <= Date.now() ||
    (!allowStopped && !saved.active)
  )
    throw new AppError("Realtime call has ended or expired", 409);
  return saved;
}

function saveSession(streamSid: string, saved: Session) {
  setChannelState(
    sessionKey(streamSid),
    JSON.stringify(saved),
    Math.max(1, saved.expiresAt - Date.now()),
  );
}

/** Extract spoken text before decoding entities, preserving literal names and codes. */
export function xmlToRealtimePrompt(xml: string): string {
  return Array.from(
    xml.matchAll(/<Say\b[^>]*>([\s\S]*?)<\/Say\s*>/gi),
    (match) =>
      match[1]
        .replace(/<[^>]*>/g, " ")
        .replace(
          /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
          (entity, code: string) => {
            const named: Record<string, string> = {
              amp: "&",
              lt: "<",
              gt: ">",
              quot: '"',
              apos: "'",
            };
            const lower = code.toLowerCase();
            if (named[lower] !== undefined) return named[lower];
            const point = lower.startsWith("#x")
              ? parseInt(lower.slice(2), 16)
              : parseInt(lower.slice(1), 10);
            return point > 0 &&
              point <= 0x10ffff &&
              !(point >= 0xd800 && point <= 0xdfff)
              ? String.fromCodePoint(point)
              : entity;
          },
        )
        .replace(/\s+/g, " ")
        .trim(),
  )
    .filter(Boolean)
    .join("\n");
}

function reply(callSid: string, xml: string): RealtimeReply {
  const progress = voiceProgress(callSid);
  const state = readState<Record<string, unknown>>(`voice:${callSid}`);
  const context: RealtimeContext = progress ? { step: progress.step } : {};
  if (state && progress) {
    if (typeof state.action === "string" && ACTIONS.includes(state.action))
      context.action = state.action;
    if (
      typeof state.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(state.date)
    )
      context.date = state.date;
    if (typeof state.court === "number" && [0, 1, 2].includes(state.court))
      context.court = state.court;
    if (
      typeof state.hour === "string" &&
      /^(?:[01]\d|2[0-3])$/.test(state.hour)
    )
      context.hour = state.hour;
    if (
      typeof state.duration === "number" &&
      Number.isInteger(state.duration) &&
      state.duration >= 1 &&
      state.duration <= 8
    )
      context.duration = state.duration;
  }
  const prompt = xmlToRealtimePrompt(xml);
  if (!prompt)
    throw new AppError("Realtime call prompt is temporarily unavailable", 503);
  return { prompt, context, ...(!progress ? { closed: true } : {}) };
}

function validateTicket(request: Start): Ticket {
  const hash = ticketHash(request.ticket);
  const saved = readState<Ticket>(ticketKey(hash));
  if (
    !saved ||
    saved.callSid !== request.callSid ||
    (saved.streamSid
      ? saved.streamSid !== request.streamSid
      : saved.expiresAt <= Date.now())
  )
    throw new AppError("Call credentials are invalid or expired", 403);
  if (saved.streamSid) {
    const active = session(request);
    if (active.ticketHash !== hash)
      throw new AppError("Call credentials do not match", 403);
  } else if (
    getChannelState(sessionKey(request.streamSid)) ||
    getChannelEvent(`realtime:start:${request.streamSid}`) !== null
  ) {
    // A different ticket cannot replay an already connected stream's greeting.
    throw new AppError(
      "Audio stream is already using different call credentials",
      403,
    );
  }
  return saved;
}

/** All work here is synchronous, including the existing booking transactions. */
export function handleRealtimeRequest(request: RealtimeRequest): RealtimeReply {
  if (!realtimeVoiceEnabled())
    throw new AppError("Realtime phone service is not configured", 503);
  if (request.op === "start") {
    validateTicket(request);
    return runChannelEvent(`realtime:start:${request.streamSid}`, () => {
      const ticket = validateTicket(request);
      if (
        readState(sessionKey(request.streamSid)) ||
        getChannelState(`realtime:call:${request.callSid}`)
      )
        throw new AppError("This call already has an audio stream", 409);
      rateLimit(`realtime:${request.callSid}`, 200, SESSION_TTL);
      const response = reply(
        request.callSid,
        handleVoice(request.callSid, ticket.phone, null, ""),
      );
      const saved: Session = {
        callSid: request.callSid,
        phone: ticket.phone,
        ticketHash: ticketHash(request.ticket),
        expiresAt: Date.now() + SESSION_TTL,
        active: true,
        turn: voiceProgress(request.callSid)?.turn || null,
      };
      saveSession(request.streamSid, saved);
      setChannelState(
        ticketKey(saved.ticketHash),
        JSON.stringify({ ...ticket, streamSid: request.streamSid }),
        SESSION_TTL,
      );
      setChannelState(
        `realtime:call:${request.callSid}`,
        request.streamSid,
        SESSION_TTL,
      );
      return response;
    });
  }
  session(request, request.op === "stop");
  if (request.op === "stop") {
    return runChannelEvent(`realtime:stop:${request.streamSid}`, () => {
      const saved = session(request, true);
      saveSession(request.streamSid, { ...saved, active: false });
      if (voiceProgress(request.callSid)?.turn === saved.turn)
        setChannelState(`voice:${request.callSid}`, null);
      return { prompt: "This call has ended.", context: {}, closed: true };
    });
  }
  return runChannelEvent(
    `realtime:${request.streamSid}:${request.inputId}`,
    () => {
      const saved = session(request);
      const current = voiceProgress(request.callSid);
      if (!current || current.turn !== saved.turn)
        throw new AppError("Call state has changed. Please call again", 409);
      rateLimit(`realtime:${request.callSid}`, 200, SESSION_TTL);
      const response = reply(
        request.callSid,
        handleVoice(
          request.callSid,
          saved.phone,
          current.turn,
          request.digits,
          request.transcript,
          request.interpretation,
        ),
      );
      saveSession(request.streamSid, {
        ...saved,
        active: !response.closed,
        turn: voiceProgress(request.callSid)?.turn || null,
      });
      return response;
    },
  );
}
