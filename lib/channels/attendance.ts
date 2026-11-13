import { randomUUID } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import { attendanceRecipient, type AttendanceCallSummary } from "../attendance";
import type { Booking } from "../domain";
import {
  AppError,
  attendanceBookingMatches,
  attendanceCallBlocksRetry,
  cancelBooking,
  claimAttendanceCall,
  expireAttendanceCalls,
  finishAttendanceCallSubmission,
  getAttendanceCall,
  getBooking,
  getLatestAttendanceCall,
  reserveAttendanceCall,
  runAttendanceCallEvent,
  updateAttendanceCall,
  type AttendanceCall,
} from "../store";
import { escapeXml } from "./security";
import { spokenBookingSummary } from "./voice-speech";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 65_536;
const CALLBACK_LIFETIME_MS = 30 * 60_000;
const inFlight = new Map<string, Promise<void>>();

function configuration() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  const sender = process.env.TWILIO_PHONE_NUMBER?.trim() || "";
  let origin: URL;
  try {
    origin = new URL(process.env.APP_BASE_URL || "");
  } catch {
    throw new AppError("Attendance calls need a public HTTPS address", 503);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !["", "/"].includes(origin.pathname) ||
    ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(origin.hostname)
  )
    throw new AppError("Attendance calls need a public HTTPS origin", 503);
  if (
    !/^AC[a-fA-F0-9]{32}$/.test(accountSid) ||
    !authToken ||
    !/^\+[1-9]\d{7,14}$/.test(sender)
  )
    throw new AppError(
      "Attendance calls need a configured Twilio number and credentials",
      503,
    );
  return { accountSid, authToken, sender, callbackOrigin: origin.origin };
}

function summary(
  value: AttendanceCall,
  booking: Booking,
): AttendanceCallSummary {
  const same = attendanceBookingMatches(value, booking);
  const cancelled =
    value.status === "cancelled" &&
    booking.status === "cancelled" &&
    booking.version === value.bookingVersion + 1;
  const eligible =
    booking.status === "confirmed" &&
    Date.parse(booking.startsAt) > Date.now() &&
    Boolean(attendanceRecipient(booking.phone));
  return {
    id: value.id,
    bookingId: value.bookingId,
    bookingVersion: value.bookingVersion,
    status: same || cancelled ? value.status : "stale",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canRetry:
      eligible &&
      !attendanceCallBlocksRetry(value) &&
      !(same && ["attending", "cancelled"].includes(value.status)),
  };
}

export function getAttendanceSummaries(
  bookings: Booking[],
): Record<string, AttendanceCallSummary> {
  const result: Record<string, AttendanceCallSummary> = {};
  for (const booking of bookings) {
    expireAttendanceCalls(booking.id);
    const value = getLatestAttendanceCall(booking.id);
    if (value) result[booking.id] = summary(value, booking);
  }
  return result;
}

function callbackUrl(
  value: AttendanceCall,
  event?: "status",
  turn?: string,
): string {
  const url = new URL("/api/webhooks/attendance", value.callbackOrigin);
  url.searchParams.set("attempt", value.id);
  if (event) url.searchParams.set("event", event);
  if (turn) url.searchParams.set("turn", turn);
  return url.toString();
}

type Submission = {
  status: "submitted" | "failed" | "unknown";
  callSid?: string;
};

async function submitCall(value: AttendanceCall): Promise<Submission> {
  let config: ReturnType<typeof configuration>;
  try {
    config = configuration();
  } catch {
    return { status: "failed" };
  }
  if (
    config.accountSid !== value.accountSid ||
    config.sender !== value.sender ||
    config.callbackOrigin !== value.callbackOrigin
  )
    return { status: "failed" };
  const params = new URLSearchParams({
    From: value.sender,
    To: value.recipient,
    Url: callbackUrl(value),
    Method: "POST",
    StatusCallback: callbackUrl(value, "status"),
    StatusCallbackMethod: "POST",
    Timeout: "20",
    TimeLimit: "120",
  });
  for (const event of ["initiated", "ringing", "answered", "completed"])
    params.append("StatusCallbackEvent", event);
  const body = params.toString();
  // Keep the credential destination fixed and inherit deployment proxy/CA trust.
  const agent = new Agent({ proxyEnv: process.env, keepAlive: false });
  try {
    return await new Promise<Submission>((resolve) => {
      let settled = false;
      let request: ReturnType<typeof httpsRequest> | undefined;
      const finish = (result: Submission) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ status: "unknown" });
        request?.destroy();
      }, REQUEST_TIMEOUT_MS);
      try {
        request = httpsRequest(
          `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
          {
            method: "POST",
            agent,
            headers: {
              authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (response) => {
            if (
              response.statusCode &&
              response.statusCode >= 400 &&
              response.statusCode < 500
            ) {
              finish({ status: "failed" });
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > MAX_RESPONSE_BYTES) {
                finish({ status: "unknown" });
                response.destroy();
              } else chunks.push(chunk);
            });
            response.once("error", () => finish({ status: "unknown" }));
            response.once("aborted", () => finish({ status: "unknown" }));
            response.once("end", () => {
              try {
                const parsed: unknown = JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                );
                const sid =
                  parsed && typeof parsed === "object" && "sid" in parsed
                    ? parsed.sid
                    : null;
                finish(
                  response.statusCode === 201 &&
                    typeof sid === "string" &&
                    /^CA[a-fA-F0-9]{32}$/.test(sid)
                    ? { status: "submitted", callSid: sid }
                    : { status: "unknown" },
                );
              } catch {
                finish({ status: "unknown" });
              }
            });
          },
        );
        request.once("error", () => finish({ status: "unknown" }));
        request.end(body);
      } catch {
        finish({ status: "unknown" });
      }
    });
  } catch {
    // Provider bodies and transport errors can contain private data. Never log.
    return { status: "unknown" };
  } finally {
    agent.destroy();
  }
}

async function processPending(value: AttendanceCall): Promise<void> {
  if (!claimAttendanceCall(value.id)) return;
  const result = await submitCall(value);
  try {
    finishAttendanceCallSubmission(value.id, result.status, result.callSid);
  } catch {
    // The durable processing claim still prevents another provider submission.
  }
}

export async function startAttendanceCall(
  bookingId: string,
  version: number,
  requestId: string,
): Promise<AttendanceCallSummary> {
  if (typeof requestId !== "string" || !UUID.test(requestId))
    throw new AppError("Invalid request ID. Refresh and try again", 400);
  const config = configuration();
  expireAttendanceCalls(bookingId);
  const value = reserveAttendanceCall({
    id: randomUUID(),
    requestId,
    bookingId,
    bookingVersion: version,
    accountSid: config.accountSid,
    sender: config.sender,
    callbackOrigin: config.callbackOrigin,
  });
  const existing = inFlight.get(value.id);
  if (existing) await existing;
  else if (value.submissionStatus === "pending") {
    // Reserve and claim commit before creating any network request.
    const sending = processPending(value);
    inFlight.set(value.id, sending);
    try {
      await sending;
    } finally {
      inFlight.delete(value.id);
    }
  }
  return summary(
    getAttendanceCall(value.id) || value,
    getBooking(bookingId, undefined, true),
  );
}

function say(text: string): string {
  return `<Say language="en-AU" voice="Polly.Olivia-Neural">${escapeXml(text)}</Say>`;
}

function response(content = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
}

function endCall(
  value: AttendanceCall,
  text: string,
  status: AttendanceCall["status"],
): string {
  updateAttendanceCall(value.id, {
    ...value,
    status,
    phase: "done",
    turn: null,
  });
  return response(`${say(text)}<Hangup/>`);
}

function ask(
  value: AttendanceCall,
  phase: "attendance" | "confirm",
  retry = false,
): string {
  const turn = randomUUID();
  updateAttendanceCall(value.id, {
    ...value,
    status: "in-progress",
    phase,
    turn,
    unclearCount: retry ? value.unclearCount + 1 : 0,
  });
  const prompt =
    phase === "attendance"
      ? `${retry ? "I didn't catch that. " : `Hello, this is the tennis court. Your booking is ${spokenBookingSummary(value.booking)} `}Can you attend? Press 1 or say "I can attend". If you cannot attend, press 2 or say "I cannot attend".`
      : `${retry ? "I didn't catch that. " : "You said you cannot attend. "}Would you like to cancel this booking? To confirm cancellation, press 1 or say "confirm cancellation". To keep your booking, press 2 or say "keep my booking".`;
  return response(
    `<Gather input="dtmf speech" numDigits="1" language="en-AU" speechTimeout="auto" timeout="5" actionOnEmptyResult="true" method="POST" action="${escapeXml(callbackUrl(value, undefined, turn))}">${say(prompt)}</Gather>${say("No confirmation was received. Your booking has been kept. Goodbye.")}<Hangup/>`,
  );
}

function speechChoice(
  value: string,
  phase: AttendanceCall["phase"],
): "yes" | "no" | null {
  // A question is not consent, even when its words match a confirmation label.
  if (/[?？]/.test(value)) return null;
  const text = value
    .toLowerCase()
    .replace(/[\s，。！？,.!?;；:：“”"'’、]/g, "");
  if (phase === "confirm") {
    if (
      /^(确认取消|我确认取消|确认取消预约|我确认取消预约|确定取消|确定取消预约|取消预约|confirmcancel|confirmcancellation|iconfirmcancellation|iconfirmcancel|confirmthecancellation|cancelmybooking|cancelthebooking)$/.test(
        text,
      )
    )
      return "yes";
    if (
      /^(保留预约|不要取消|不取消|我会来|能来|能到场|我能到场|可以到场|我会到场|keepbooking|keepmybooking|keepthebooking|donotcancel|dontcancel|donotcancelmybooking|dontcancelmybooking|icanattend|iwillattend)$/.test(
        text,
      )
    )
      return "no";
  } else {
    if (
      /^(能来|可以来|我能来|我会来|会来|能参加|可以参加|我能参加|会参加|能到场|我能到场|可以到场|我会到场|attend|attending|icanattend|iwillattend|illattend|icanmakeit|iwillbethere|illbethere|yes)$/.test(
        text,
      )
    )
      return "yes";
    if (
      /^(不能来|我不能来|来不了|我来不了|不能参加|我不能参加|无法参加|不能到场|我不能到场|cannotattend|icannotattend|cantattend|icantattend|unabletoattend|imunabletoattend|icannotmakeit|icantmakeit|iwontbethere)$/.test(
        text,
      )
    )
      return "no";
  }
  return null;
}

function choice(
  form: URLSearchParams,
  phase: AttendanceCall["phase"],
): "yes" | "no" | null {
  const digits = form.get("Digits")?.trim() || "";
  const speech = form.get("SpeechResult")?.trim() || "";
  const confidence = form.get("Confidence");
  const spoken =
    speech &&
    (confidence === null ||
      (/^\d*(?:\.\d+)?$/.test(confidence) &&
        Number(confidence) >= 0.8 &&
        Number(confidence) <= 1))
      ? speechChoice(speech, phase)
      : null;
  const pressed = digits === "1" ? "yes" : digits === "2" ? "no" : null;
  if (digits && speech) return pressed && spoken === pressed ? pressed : null;
  return digits ? pressed : spoken;
}

function statusCallback(value: AttendanceCall, form: URLSearchParams): string {
  if (value.phase === "done" && value.status !== "unknown") return response();
  const status = form.get("CallStatus");
  if (
    ["completed", "busy", "no-answer", "failed", "canceled"].includes(
      status || "",
    )
  ) {
    updateAttendanceCall(value.id, {
      ...value,
      status:
        status === "busy" || status === "no-answer"
          ? "unanswered"
          : status === "failed"
            ? "failed"
            : "completed",
      phase: "done",
      turn: null,
    });
  } else {
    const next =
      status === "ringing"
        ? "ringing"
        : status === "in-progress"
          ? "in-progress"
          : status === "queued" || status === "initiated"
            ? "queued"
            : null;
    const rank = {
      requesting: 0,
      unknown: 0,
      queued: 1,
      ringing: 2,
      "in-progress": 3,
    };
    if (next && rank[next] > (rank[value.status as keyof typeof rank] ?? 4))
      updateAttendanceCall(value.id, { ...value, status: next });
  }
  return response();
}

/** Call only after verifying the Twilio signature over the exact public URL. */
export function handleAttendanceWebhook(
  form: URLSearchParams,
  query: URLSearchParams,
): string {
  const attempt = query.get("attempt") || "";
  const turn = query.get("turn");
  const event = query.get("event");
  if (
    !UUID.test(attempt) ||
    (turn !== null && !UUID.test(turn)) ||
    (event !== null && event !== "status") ||
    (turn !== null && event !== null) ||
    [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1) ||
    [...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)
  )
    throw new AppError("Invalid attendance call callback", 400);
  const key =
    event === "status"
      ? `status:${form.get("SequenceNumber") || ""}:${form.get("CallStatus") || ""}`
      : `voice:${turn || "initial"}`;
  return runAttendanceCallEvent(
    attempt,
    key,
    {
      callSid: form.get("CallSid") || "",
      accountSid: form.get("AccountSid") || "",
      sender: form.get("From") || "",
      recipient: form.get("To") || "",
    },
    (value) => {
      if (event === "status") return statusCallback(value, form);
      if (value.phase === "done")
        return response(
          `${say("This attendance call has ended. Please check your booking on the website. Goodbye.")}<Hangup/>`,
        );
      if (Date.now() - value.createdAt > CALLBACK_LIFETIME_MS)
        return endCall(
          value,
          "This attendance confirmation has expired. Your booking has been kept. Please check it on the website. Goodbye.",
          "unknown",
        );
      const booking = getBooking(value.bookingId, undefined, true);
      if (!attendanceBookingMatches(value, booking))
        return endCall(
          value,
          "Your booking details have changed. This call will leave the booking unchanged. Please contact staff. Goodbye.",
          "stale",
        );
      if (turn === null) {
        if (value.phase !== "initial")
          return response(
            `${say("No valid confirmation was received. Your booking has been kept. Goodbye.")}<Hangup/>`,
          );
        return ask(value, "attendance");
      }
      if (
        turn !== value.turn ||
        !["attendance", "confirm"].includes(value.phase)
      )
        return response(
          `${say("No valid confirmation was received. Your booking has been kept. Goodbye.")}<Hangup/>`,
        );
      const answer = choice(form, value.phase);
      if (!answer) {
        if (value.unclearCount >= 1)
          return endCall(
            value,
            "I couldn't confirm your answer. Your booking has been kept. Please contact staff if you need help. Goodbye.",
            "completed",
          );
        return ask(value, value.phase as "attendance" | "confirm", true);
      }
      if (value.phase === "attendance") {
        if (answer === "yes")
          return endCall(
            value,
            "Thank you. Your attendance is confirmed and your booking has been kept. We look forward to seeing you. Goodbye.",
            "attending",
          );
        return ask(value, "confirm");
      }
      if (answer === "no")
        return endCall(
          value,
          "Your booking has been kept. Goodbye.",
          "completed",
        );
      // The event transaction also contains this optimistic cancellation and its
      // saved XML. Retries cannot cancel twice or affect a later booking version.
      cancelBooking(value.bookingId, value.bookingVersion, undefined, true);
      return endCall(
        value,
        "Your booking has been cancelled and the court is now available. Thank you for letting us know. Goodbye.",
        "cancelled",
      );
    },
  );
}
