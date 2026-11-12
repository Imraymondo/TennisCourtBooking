import { Agent, request as httpsRequest } from "node:https";
import { COURTS, TIME_ZONE, type Booking } from "../domain";
import {
  claimPhoneBookingSmsOutbox,
  expirePhoneBookingSmsOutbox,
  finishPhoneBookingSmsOutbox,
  getBooking,
  getPhoneBookingSmsOutbox,
  savePhoneBookingSmsOutbox,
  type PhoneBookingSmsOutbox,
} from "../store";
import { spokenAccessCode, spokenBookingSummary } from "./voice-speech";

export const PHONE_SMS_PENDING_PROMPT = "预约成功，详情短信正在发送。";
export function phoneSmsPendingPrompt(bookingId: string): string {
  return `${PHONE_SMS_PENDING_PROMPT}预约编号：${bookingId}。`;
}
const REQUEST_TIMEOUT_MS = 4_000;
const PROCESSING_EXPIRY_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const E164 = /^\+[1-9]\d{7,14}$/;
const inFlight = new Map<string, Promise<void>>();

function configuration() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  const sender = process.env.TWILIO_PHONE_NUMBER?.trim() || "";
  return /^AC[a-fA-F0-9]{32}$/.test(accountSid) &&
    authToken &&
    E164.test(sender)
    ? { accountSid, authToken, sender }
    : null;
}

// Only explicit international numbers and Australian local mobile numbers are
// usable here. An ambiguous contact never falls back to the caller's identity.
function smsRecipient(value: string): string | null {
  if (!/^[+\d ()-]+$/.test(value)) return null;
  let phone = value.replace(/[ ()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (/^04\d{8}$/.test(phone)) phone = `+61${phone.slice(1)}`;
  return E164.test(phone) ? phone : null;
}

function smsDate(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function receipt(booking: Booking, accessCode: string) {
  const court = COURTS.find((value) => value.id === booking.courtId)!.name;
  return `预约成功。姓名：${booking.customerName}。${court}，悉尼时间${smsDate(booking.startsAt)}至${smsDate(booking.endsAt)}，共${booking.durationHours}小时。预约编号：${booking.id}。管理码：${accessCode}。请妥善保管。`;
}

export function queuePhoneBookingSms(
  callSid: string,
  created: { booking: Booking; accessCode: string },
): boolean {
  try {
    const config = configuration();
    if (!config || !callSid) return false;
    // Use the stored, explicitly confirmed contact, never untrusted call fields.
    const booking = getBooking(created.booking.id, created.accessCode);
    const recipient = smsRecipient(booking.phone);
    if (
      booking.source !== "phone" ||
      booking.status !== "confirmed" ||
      booking.version !== 1 ||
      !recipient
    )
      return false;
    return savePhoneBookingSmsOutbox({
      callSid,
      booking,
      accessCode: created.accessCode,
      sender: config.sender,
      recipient,
      body: receipt(booking, created.accessCode),
    });
  } catch {
    // A receipt problem must never roll back a successfully created booking.
    return false;
  }
}

type Submission = {
  status: "submitted" | "failed" | "unknown";
  messageSid?: string;
};

async function submitSms(value: PhoneBookingSmsOutbox): Promise<Submission> {
  const config = configuration();
  if (!config || config.sender !== value.sender) return { status: "failed" };
  const body = new URLSearchParams({
    From: value.sender,
    To: value.recipient,
    Body: value.body,
  }).toString();
  // Inherit the deployment's proxy and CA trust; keep the destination fixed.
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
      // An explicit timer also bounds response streaming, beyond socket timeout.
      const timer = setTimeout(() => {
        finish({ status: "unknown" });
        request?.destroy();
      }, REQUEST_TIMEOUT_MS);
      try {
        request = httpsRequest(
          `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
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
                    /^SM[a-fA-F0-9]{32}$/.test(sid)
                    ? { status: "submitted", messageSid: sid }
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
    // Request errors and provider bodies can contain private data. Do not log.
    return { status: "unknown" };
  } finally {
    agent.destroy();
  }
}

async function processPending(value: PhoneBookingSmsOutbox) {
  if (!claimPhoneBookingSmsOutbox(value.id)) return;
  const result = await submitSms(value);
  finishPhoneBookingSmsOutbox(value.id, result.status, result.messageSid);
}

function fallback(value: PhoneBookingSmsOutbox) {
  const status =
    value.status === "failed" ? "短信暂时发送不了" : "短信发送状态未确认";
  return `预约成功，${status}。${spokenBookingSummary(value.booking, new Date(value.createdAt))}预约编号：${spokenAccessCode(value.booking.id)}。管理码：${spokenAccessCode(value.accessCode)}。请妥善保管。`;
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Run only after runChannelEvent commits. Cached responses contain the marker,
// so replay reads the durable result without creating another provider request.
export async function finalizePhoneBookingSms(
  callSid: string,
  speech: string,
): Promise<string> {
  if (!speech.includes(PHONE_SMS_PENDING_PROMPT)) return speech;
  const match = /预约成功，详情短信正在发送。预约编号：(\d{8})。/.exec(speech);
  const pendingPrompt = match?.[0] || PHONE_SMS_PENDING_PROMPT;
  const bookingId = match?.[1];
  let replacement = "预约成功，短信发送状态未确认。";
  try {
    // A cached response must remain bound to its booking even if the same call
    // creates another booking later. A bare marker never selects another task.
    let value = bookingId ? getPhoneBookingSmsOutbox(callSid, bookingId) : null;
    if (value) {
      // Once the receipt is known, keep it available even if claiming, saving
      // the provider result, or reading the final status subsequently fails.
      replacement = fallback(value);
      const existing = inFlight.get(value.id);
      if (existing) await existing;
      else if (value.status === "pending") {
        const sending = processPending(value);
        inFlight.set(value.id, sending);
        try {
          await sending;
        } finally {
          inFlight.delete(value.id);
        }
      }
      expirePhoneBookingSmsOutbox(value.id, Date.now() - PROCESSING_EXPIRY_MS);
      value = getPhoneBookingSmsOutbox(callSid, bookingId!) || value;
      replacement =
        value.status === "submitted" || value.status === "processing"
          ? PHONE_SMS_PENDING_PROMPT
          : fallback(value);
    }
  } catch {
    // Booking success remains success even if the outbox cannot be read/written.
  }
  const isXml = /<(?:Response|Gather|Say)\b/.test(speech);
  return speech.replaceAll(
    pendingPrompt,
    isXml ? xmlEscape(replacement) : replacement,
  );
}
