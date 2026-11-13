import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { POST as realtimeTurn } from "../app/api/realtime/turn/route";
import { POST as voiceWebhook } from "../app/api/webhooks/voice/route";
import type { BookingInterpretation } from "../lib/channels/booking-ai";
import { createRealtimeVoice } from "../lib/channels/realtime";
import { handleVoice } from "../lib/channels/voice";
import {
  closeDatabase,
  createBooking,
  getBooking,
  getChannelState,
  getDatabase,
  listBookings,
} from "../lib/store";

const INTERNAL_URL = "http://127.0.0.1:3000/api/realtime/turn";
const WEBHOOK_URL = "https://courts.example/api/webhooks/voice";
const PHONE = "+61400123456";

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "";
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.VOICE_MODE = "realtime";
  process.env.OPENAI_API_KEY = "test-only-realtime-openai-key";
  process.env.REALTIME_BRIDGE_SECRET = "test-only-realtime-bridge-secret";
  process.env.TWILIO_AUTH_TOKEN = "test-only-realtime-signature-key";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
});
after(closeDatabase);

function identifier(prefix: "CA" | "MS") {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function understanding(
  fields: Partial<BookingInterpretation> = {},
): BookingInterpretation {
  return {
    scope: "booking",
    action: null,
    date: null,
    court: null,
    hour: null,
    duration: null,
    name: null,
    correction: null,
    ...fields,
  };
}

function internalRequest(body: unknown, authorized = true) {
  return new Request(INTERNAL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized
        ? { authorization: `Bearer ${process.env.REALTIME_BRIDGE_SECRET}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function ticketedCall() {
  const callSid = identifier("CA");
  const streamSid = identifier("MS");
  const xml = createRealtimeVoice(callSid, PHONE);
  const ticket = xml.match(
    /<Parameter\b[^>]*name="ticket"[^>]*value="([a-f0-9]{64})"/,
  )?.[1];
  assert.ok(ticket, "stream XML carries one random 32-byte ticket");
  const startBody = { op: "start", callSid, streamSid, ticket };
  const send = (
    transcript: string,
    interpretation?: BookingInterpretation | Record<string, unknown>,
    digits?: string,
    inputId = `item_${randomUUID().replaceAll("-", "")}`,
  ) => {
    const body = {
      op: "turn",
      callSid,
      streamSid,
      inputId,
      transcript,
      ...(interpretation === undefined ? {} : { interpretation }),
      ...(digits === undefined ? {} : { digits }),
    };
    return {
      body,
      response: () => realtimeTurn(internalRequest(body)),
    };
  };
  return {
    callSid,
    streamSid,
    ticket,
    xml,
    startBody,
    start: () => realtimeTurn(internalRequest(startBody)),
    send,
    stop: () =>
      realtimeTurn(internalRequest({ op: "stop", callSid, streamSid })),
    state: () => JSON.parse(getChannelState(`voice:${callSid}`)!),
  };
}

async function pendingBooking() {
  const call = ticketedCall();
  assert.equal((await call.start()).status, 200);
  const collect = await call
    .send(
      "帮我安排2099年12月1日下午三点二号场打三个小时，我叫张三",
      understanding({
        action: "book",
        date: "2099-12-01",
        court: 2,
        hour: "15",
        duration: 3,
        name: "张三",
      }),
    )
    .response();
  assert.equal(collect.status, 200);
  const contact = await collect.json();
  assert.match(contact.prompt, /contact number/i);
  assert.equal(call.state().step, "contact");
  assert.equal(
    call.state().court,
    1,
    "the server gives court 1 priority over the requested court",
  );
  const summary = await call.send("使用来电号码").response();
  assert.equal(summary.status, 200);
  assert.match((await summary.json()).prompt, /Booking name: 张三/);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  return call;
}

function occupy(courtId: 1 | 2, startLocal: string, durationHours: number) {
  return createBooking({
    courtId,
    startLocal,
    durationHours,
    customerName: "其他预约人",
    phone: "+61400999999",
    source: "web",
  });
}

function signedVoiceRequest(callSid: string, signed = true) {
  const fields = {
    CallSid: callSid,
    To: process.env.TWILIO_PHONE_NUMBER!,
    From: PHONE,
  };
  const material =
    WEBHOOK_URL +
    Object.keys(fields)
      .sort()
      .map((key) => key + fields[key as keyof typeof fields])
      .join("");
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signed
        ? {
            "x-twilio-signature": createHmac(
              "sha1",
              process.env.TWILIO_AUTH_TOKEN!,
            )
              .update(material)
              .digest("base64"),
          }
        : {}),
    },
    body: new URLSearchParams(fields),
  });
}

test("Realtime webhook requires a valid signature and retries replay the exact ticket", async () => {
  const callSid = identifier("CA");
  assert.equal(
    (await voiceWebhook(signedVoiceRequest(callSid, false))).status,
    403,
  );
  const first = await voiceWebhook(signedVoiceRequest(callSid));
  assert.equal(first.status, 200);
  const xml = await first.text();
  assert.match(
    xml,
    /<Connect><Stream url="wss:\/\/courts\.example\/api\/realtime\/voice">/,
  );
  assert.match(xml, /<Parameter name="ticket" value="[a-f0-9]{64}"\/>/);
  assert.match(xml, /<Say\b/);
  assert.doesNotMatch(
    xml,
    /test-only-realtime-openai-key|test-only-realtime-bridge-secret/,
  );
  assert.equal(
    await (await voiceWebhook(signedVoiceRequest(callSid))).text(),
    xml,
  );
});

test("Realtime is explicit opt-in and the internal route requires its server secret", async () => {
  const call = ticketedCall();
  assert.equal(
    (await realtimeTurn(internalRequest(call.startBody, false))).status,
    403,
  );
  const wrong = internalRequest(call.startBody);
  wrong.headers.set("authorization", "Bearer incorrect-secret");
  assert.equal((await realtimeTurn(wrong)).status, 403);
  process.env.VOICE_MODE = "gather";
  assert.equal((await call.start()).status, 503);
  const gather = await voiceWebhook(signedVoiceRequest(identifier("CA")));
  assert.match(await gather.text(), /<Gather\b/);
  process.env.VOICE_MODE = "realtime";
  process.env.OPENAI_API_KEY = " ";
  assert.equal((await call.start()).status, 503);
});

test("tickets are stored hashed, bound to a call, consumed once, and replayed only on the same stream", async () => {
  const call = ticketedCall();
  const rows = getDatabase()
    .prepare("SELECT key, value FROM channel_state")
    .all();
  assert.ok(rows.length > 0);
  assert.equal(JSON.stringify(rows).includes(call.ticket), false);
  assert.equal(
    (
      await realtimeTurn(
        internalRequest({
          ...call.startBody,
          ticket: "0".repeat(64),
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await realtimeTurn(
        internalRequest({
          ...call.startBody,
          callSid: identifier("CA"),
        }),
      )
    ).status,
    403,
  );
  const first = await call.start();
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.match(result.prompt, /book a court/);
  assert.equal(result.context.step, "menu");
  assert.deepEqual(await (await call.start()).json(), result);
  assert.equal(
    (
      await realtimeTurn(
        internalRequest({
          ...call.startBody,
          streamSid: identifier("MS"),
        }),
      )
    ).status,
    403,
  );
});

test("tickets expire before a stream can begin", async () => {
  const call = ticketedCall();
  const originalNow = Date.now;
  const created = Date.now();
  Date.now = () => created + 120_001;
  try {
    assert.equal((await call.start()).status, 403);
    assert.equal(listBookings().length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("natural fields fill the existing voice form and only a raw confirmation writes exactly once", async () => {
  const call = await pendingBooking();
  const confirm = call.send("确认预约");
  const first = await confirm.response();
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.match(result.prompt, /Booking confirmed/);
  assert.match(result.prompt, /booking reference/i);
  assert.match(result.prompt, /Access code/i);
  assert.doesNotMatch(result.prompt, /<Say|<Gather|&amp;|&lt;/);
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.phone, PHONE);
  assert.equal(booking.source, "phone");
  assert.equal(booking.courtId, 1);
  assert.equal(booking.durationHours, 3);
  assert.equal(booking.startsAt, "2099-12-01T04:00:00Z");
  assert.deepEqual(await (await confirm.response()).json(), result);
  assert.equal(listBookings().length, 1);
  for (const privateField of [
    "name",
    "phone",
    "contactPhone",
    "id",
    "code",
    "turn",
    "version",
  ])
    assert.equal(
      Object.hasOwn(result.context, privateField),
      false,
      privateField,
    );
});

test("English Realtime booking uses native English prompts and commits only after a raw confirmation", async () => {
  const call = ticketedCall();
  const started = await call.start();
  assert.equal(started.status, 200);
  const greeting = await started.json();
  assert.match(
    greeting.prompt,
    /Hello\. Would you like to book a court or check availability\?/,
  );
  assert.doesNotMatch(greeting.prompt, /[\p{Script=Han}]/u);

  for (const [transcript, step] of [
    ["I want to book a court", "date"],
    ["1 December 2099", "hour"],
    ["3 pm", "duration"],
    ["three hours", "name"],
    ["My name is Alice", "contact"],
    ["use my calling number", "confirm"],
  ]) {
    const turn = call.send(transcript);
    assert.equal(Object.hasOwn(turn.body, "interpretation"), false);
    const response = await turn.response();
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.context.step, step);
    assert.doesNotMatch(reply.prompt, /[\p{Script=Han}]/u);
    assert.doesNotMatch(reply.prompt, /<Say|<Gather|&amp;|&lt;/);
    assert.equal(listBookings().length, 0);
  }

  const invented = await call
    .send("I need to think about it", understanding({ action: "book" }))
    .response();
  assert.equal(invented.status, 200);
  assert.equal((await invented.json()).context.step, "confirm");
  assert.equal(listBookings().length, 0);

  const confirmation = call.send("confirm booking");
  const committed = await confirmation.response();
  assert.equal(committed.status, 200);
  const receipt = await committed.json();
  assert.match(receipt.prompt, /Booking confirmed/);
  assert.doesNotMatch(receipt.prompt, /[\p{Script=Han}]/u);
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.customerName, "Alice");
  assert.equal(booking.phone, PHONE);
  assert.equal(booking.courtId, 1);
  assert.equal(booking.startsAt, "2099-12-01T04:00:00Z");
  assert.equal(booking.durationHours, 3);
  assert.deepEqual(await (await confirmation.response()).json(), receipt);
  assert.equal(listBookings().length, 1);
});

test("raw Realtime booking skips court selection and assigns a court available for the whole requested duration", async () => {
  occupy(1, "2099-12-01T17:00", 1);
  const call = ticketedCall();
  assert.equal((await call.start()).status, 200);
  for (const [transcript, step] of [
    ["我要预约", "date"],
    ["2099年12月1日", "hour"],
    ["下午三点", "duration"],
    ["三个小时", "name"],
    ["我叫张三", "contact"],
    ["使用来电号码", "confirm"],
  ]) {
    const response = await call.send(transcript).response();
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.context.step, step);
    assert.doesNotMatch(
      reply.prompt,
      /choose (?:a|which|between).*court|(?:which|what) court/i,
    );
    assert.equal(
      listBookings().length,
      1,
      "collecting fields never creates another booking",
    );
  }
  assert.equal(
    call.state().court,
    2,
    "court 1 overlaps the third requested hour",
  );
  assert.equal(call.state().duration, 3);
  const response = await call.send("确认预约").response();
  assert.equal(response.status, 200);
  assert.match((await response.json()).prompt, /Booking confirmed/);
  const booked = listBookings().find((booking) => booking.source === "phone")!;
  assert.ok(booked);
  assert.equal(booked.courtId, 2);
  assert.equal(booked.startsAt, "2099-12-01T04:00:00Z");
  assert.equal(booked.endsAt, "2099-12-01T07:00:00Z");
  assert.equal(booked.durationHours, 3);
});

test("a raw combined date, time, and duration reaches review without a court question", async () => {
  const call = ticketedCall();
  assert.equal((await call.start()).status, 200);
  for (const [transcript, step] of [
    ["我要预约", "date"],
    ["2099年12月2日下午四点两个小时", "name"],
    ["我叫张三", "contact"],
    ["使用来电号码", "confirm"],
  ]) {
    const turn = call.send(transcript);
    assert.equal(Object.hasOwn(turn.body, "interpretation"), false);
    const response = await turn.response();
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.context.step, step);
    assert.doesNotMatch(
      reply.prompt,
      /choose (?:a|which|between).*court|(?:which|what) court/i,
    );
    assert.equal(listBookings().length, 0);
  }
  assert.equal(call.state().date, "2099-12-02");
  assert.equal(call.state().hour, "16");
  assert.equal(call.state().duration, 2);
  assert.equal(call.state().court, 1);
  const confirmation = call.send("确认预约");
  const response = await confirmation.response();
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.match(receipt.prompt, /Booking confirmed/);
  assert.equal(listBookings().length, 1);
  assert.equal(listBookings()[0].startsAt, "2099-12-02T05:00:00Z");
  assert.equal(listBookings()[0].durationHours, 2);
  assert.deepEqual(await (await confirmation.response()).json(), receipt);
  assert.equal(listBookings().length, 1);
});

for (const invalidSchedule of [
  "2099年12月2日下午四点九个小时",
  "2099年12月2日下午四点半",
  "2099年12月2日下午四点到五点",
]) {
  test(`a date correction with ${invalidSchedule} asks again before reviewing a replacement schedule`, async () => {
    const call = await pendingBooking();
    const smsCount = () =>
      Number(
        getDatabase()
          .prepare(
            "SELECT COUNT(*) AS count FROM phone_booking_sms_outbox WHERE call_sid = ?",
          )
          .get(call.callSid)!.count,
      );
    const correction = await call.send("修改日期").response();
    assert.equal(correction.status, 200);
    assert.equal((await correction.json()).context.step, "date");
    const invalidTurn = call.send(invalidSchedule);
    assert.equal(Object.hasOwn(invalidTurn.body, "interpretation"), false);
    const response = await invalidTurn.response();
    assert.equal(response.status, 200);
    const clarification = await response.json();
    assert.ok(
      ["date", "hour", "duration"].includes(clarification.context.step),
      "an invalid supplied schedule must require clarification",
    );
    assert.doesNotMatch(
      clarification.prompt,
      /Booking confirmed|Please review:|press 1 to confirm/i,
    );
    assert.equal(listBookings().length, 0);
    assert.equal(smsCount(), 0);
    assert.deepEqual(
      await (await invalidTurn.response()).json(),
      clarification,
    );
    const premature = await call.send("确认预约").response();
    assert.equal(premature.status, 200);
    assert.ok(
      ["date", "hour", "duration"].includes(
        (await premature.json()).context.step,
      ),
      "confirmation cannot commit the old schedule while clarification is pending",
    );
    assert.equal(listBookings().length, 0);
    assert.equal(smsCount(), 0);

    const replacement =
      call.state().step === "date"
        ? "2099年12月2日下午四点两个小时"
        : call.state().step === "hour"
          ? "下午四点两个小时"
          : "两个小时";
    const corrected = await call.send(replacement).response();
    assert.equal(corrected.status, 200);
    const review = await corrected.json();
    assert.equal(review.context.step, "confirm");
    assert.equal(call.state().date, "2099-12-02");
    assert.equal(call.state().hour, "16");
    assert.equal(call.state().duration, 2);
    assert.equal(call.state().court, 1);
    assert.doesNotMatch(
      review.prompt,
      /choose (?:a|which|between).*court|(?:which|what) court/i,
    );
    assert.equal(listBookings().length, 0);
    assert.equal(smsCount(), 0);
    const confirmation = call.send("确认预约");
    const confirmed = await confirmation.response();
    assert.equal(confirmed.status, 200);
    const receipt = await confirmed.json();
    assert.match(receipt.prompt, /Booking confirmed/);
    assert.equal(listBookings().length, 1);
    assert.equal(listBookings()[0].startsAt, "2099-12-02T05:00:00Z");
    assert.equal(listBookings()[0].durationHours, 2);
    assert.equal(listBookings()[0].courtId, 1);
    assert.deepEqual(await (await confirmation.response()).json(), receipt);
    assert.equal(listBookings().length, 1);
  });
}

test("a last-second court conflict presents the other court for a fresh confirmation before writing", async () => {
  const call = await pendingBooking();
  assert.equal(call.state().court, 1);
  occupy(1, "2099-12-01T15:00", 3);
  const staleConfirmation = call.send("确认预约");
  const response = await staleConfirmation.response();
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(review.context.step, "confirm");
  assert.equal(call.state().court, 2);
  assert.match(review.prompt, /Court 2/);
  assert.doesNotMatch(review.prompt, /Booking confirmed/);
  assert.equal(
    listBookings().length,
    1,
    "changing the reviewed court needs another confirmation",
  );
  assert.deepEqual(await (await staleConfirmation.response()).json(), review);
  assert.equal(listBookings().length, 1);
  const confirmed = await call.send("确认预约").response();
  assert.equal(confirmed.status, 200);
  assert.match((await confirmed.json()).prompt, /Booking confirmed/);
  assert.equal(listBookings().length, 2);
  assert.equal(
    listBookings().find((booking) => booking.source === "phone")?.courtId,
    2,
  );
});

test("when both courts become busy Realtime asks for another time and reviews its automatic court before committing", async () => {
  const call = await pendingBooking();
  occupy(1, "2099-12-01T15:00", 3);
  occupy(2, "2099-12-01T15:00", 3);
  const staleConfirmation = call.send("确认预约");
  const response = await staleConfirmation.response();
  assert.equal(response.status, 200);
  const unavailable = await response.json();
  assert.equal(unavailable.context.step, "hour");
  assert.equal(call.state().hour, undefined);
  assert.equal(call.state().court, undefined);
  assert.equal(call.state().duration, 3);
  assert.match(
    unavailable.prompt,
    /Neither court is available for the full booking\. Please choose another start time\./,
  );
  assert.doesNotMatch(
    unavailable.prompt,
    /choose (?:a|which|between).*court|(?:which|what) court/i,
  );
  assert.equal(listBookings().length, 2);
  assert.deepEqual(
    await (await staleConfirmation.response()).json(),
    unavailable,
  );
  const proposed = await call.send("下午六点").response();
  assert.equal(proposed.status, 200);
  const review = await proposed.json();
  assert.equal(review.context.step, "confirm");
  assert.equal(call.state().hour, "18");
  assert.equal(call.state().court, 1);
  assert.match(review.prompt, /Court 1/);
  assert.equal(
    listBookings().length,
    2,
    "a newly proposed time is reviewed before committing",
  );
  const confirmed = await call.send("确认预约").response();
  assert.equal(confirmed.status, 200);
  assert.match((await confirmed.json()).prompt, /Booking confirmed/);
  assert.equal(listBookings().length, 3);
  const booked = listBookings().find((booking) => booking.source === "phone")!;
  assert.equal(booked.courtId, 1);
  assert.equal(booked.startsAt, "2099-12-01T07:00:00Z");
  assert.equal(booked.durationHours, 3);
});

test("an authenticated reschedule ignores its own overlap across midnight and updates only after a new confirmation", async () => {
  const original = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T23:00",
    durationHours: 2,
    customerName: "张三",
    phone: PHONE,
    source: "phone",
  });
  const call = ticketedCall();
  assert.equal((await call.start()).status, 200);
  for (const [transcript, step] of [
    ["修改预约", "id"],
    [original.booking.id, "code"],
    [original.accessCode, "date"],
    ["2099年12月2日", "hour"],
    ["凌晨零点", "duration"],
    ["两个小时", "confirm"],
  ]) {
    const response = await call.send(transcript).response();
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.context.step, step);
    assert.notEqual(reply.context.step, "court");
    assert.equal(listBookings().length, 1);
    assert.equal(
      getBooking(original.booking.id, original.accessCode).version,
      1,
    );
    assert.equal(
      getBooking(original.booking.id, original.accessCode).startsAt,
      original.booking.startsAt,
    );
  }
  assert.equal(
    call.state().court,
    1,
    "the authenticated booking must not block its own court",
  );
  assert.equal(call.state().hour, "00");
  const confirmation = call.send("确认预约");
  const response = await confirmation.response();
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.match(receipt.prompt, /Booking changed/);
  const updated = getBooking(original.booking.id, original.accessCode);
  assert.equal(listBookings().length, 1);
  assert.equal(updated.id, original.booking.id);
  assert.equal(updated.courtId, 1);
  assert.equal(updated.startsAt, "2099-12-01T13:00:00Z");
  assert.equal(updated.endsAt, "2099-12-01T15:00:00Z");
  assert.equal(updated.durationHours, 2);
  assert.equal(updated.version, 2);
  assert.deepEqual(await (await confirmation.response()).json(), receipt);
  assert.equal(getBooking(original.booking.id, original.accessCode).version, 2);
});

test("raw Realtime booking accepts matching relative and calendar dates and asks again when they conflict", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-12T00:00:00Z"),
  });
  t.after(() => t.mock.timers.reset());
  const rawTurn = async (
    call: ReturnType<typeof ticketedCall>,
    transcript: string,
  ) => {
    const turn = call.send(transcript);
    assert.equal(Object.hasOwn(turn.body, "interpretation"), false);
    const response = await turn.response();
    assert.equal(response.status, 200);
    assert.equal(
      listBookings().length,
      0,
      "raw fields do not confirm a booking",
    );
    return response.json();
  };
  const call = ticketedCall();
  assert.equal((await call.start()).status, 200);
  assert.equal((await rawTurn(call, "我要预定")).context.step, "date");
  const dateTurn = call.send("明天11月13号");
  const dateResponse = await dateTurn.response();
  assert.equal(dateResponse.status, 200);
  const dateReply = await dateResponse.json();
  assert.equal(dateReply.context.step, "hour");
  assert.doesNotMatch(
    dateReply.prompt,
    /choose (?:a|which|between).*court|(?:which|what) court/i,
  );
  assert.equal(dateReply.context.date, "2026-11-13");
  assert.equal(call.state().date, "2026-11-13");
  assert.deepEqual(await (await dateTurn.response()).json(), dateReply);
  assert.equal(listBookings().length, 0);

  const conflicting = ticketedCall();
  assert.equal((await conflicting.start()).status, 200);
  assert.equal((await rawTurn(conflicting, "我要预定")).context.step, "date");
  const conflict = await rawTurn(conflicting, "明天11月14号");
  assert.equal(conflict.context.step, "date");
  assert.equal(conflicting.state().date, undefined);
  const corrected = await rawTurn(conflicting, "明天，11月13号。");
  assert.equal(corrected.context.step, "hour");
  assert.equal(corrected.context.date, "2026-11-13");

  for (const transcript of ["下午三点", "两个小时", "我叫张三", "使用来电号码"])
    await rawTurn(call, transcript);
  assert.equal(call.state().step, "confirm");
  const confirmation = call.send("确认预约");
  const committed = await confirmation.response();
  assert.equal(committed.status, 200);
  const receipt = await committed.json();
  assert.match(receipt.prompt, /Booking confirmed/);
  assert.equal(listBookings().length, 1);
  assert.equal(listBookings()[0].startsAt, "2026-11-13T04:00:00Z");
  assert.deepEqual(await (await confirmation.response()).json(), receipt);
  assert.equal(listBookings().length, 1);
});

test("model arguments cannot manufacture a confirmation or override raw denial", async () => {
  const call = await pendingBooking();
  const invented = await call
    .send("我还需要想一想", understanding({ action: "book" }))
    .response();
  assert.equal(invented.status, 200);
  assert.equal(listBookings().length, 0);
  assert.equal(call.state().step, "confirm");
  const denial = await call
    .send("不确认", understanding({ hour: "18", correction: "hour" }))
    .response();
  assert.equal(denial.status, 200);
  assert.equal(listBookings().length, 0);
  assert.equal(call.state().step, "menu");
});

test("spoken prompts decode XML entities without corrupting a caller's name", async () => {
  const call = ticketedCall();
  await call.start();
  const name = "O'Neil";
  await call
    .send(
      `我要预约2099年12月1日下午三点一号场两个小时，我叫${name}`,
      understanding({
        action: "book",
        date: "2099-12-01",
        court: 1,
        hour: "15",
        duration: 2,
        name,
      }),
    )
    .response();
  const summary = await call.send("使用来电号码").response();
  assert.equal(summary.status, 200);
  const result = await summary.json();
  assert.match(result.prompt, /Booking name: O'Neil/);
  assert.doesNotMatch(result.prompt, /&apos;|<Say|<Gather/);
  assert.equal(listBookings().length, 0);
});

test("credentials and contact answers come from the raw turn, including DTMF confirmation", async () => {
  const call = ticketedCall();
  await call.start();
  await call
    .send(
      "帮我安排2099年12月1日下午三点二号场两个小时，我叫李四",
      understanding({
        action: "book",
        date: "2099-12-01",
        court: 2,
        hour: "15",
        duration: 2,
        name: "李四",
      }),
    )
    .response();
  const contact = await call
    .send("没听清", understanding({ action: "book", name: "没听清" }))
    .response();
  assert.equal(contact.status, 200);
  assert.equal(call.state().step, "contact");
  await call.send("", undefined, "1").response();
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  assert.equal((await call.send("", undefined, "1").response()).status, 200);
  assert.equal(listBookings().length, 1);
});

test("stopping or expiring a session blocks new turns and replay cannot write again", async () => {
  const call = await pendingBooking();
  const confirm = call.send("确认预约");
  assert.equal((await call.stop()).status, 200);
  assert.equal((await confirm.response()).status, 409);
  assert.equal(listBookings().length, 0);
  const active = await pendingBooking();
  const committed = active.send("确认预约");
  assert.equal((await committed.response()).status, 200);
  assert.equal(listBookings().length, 1);
  assert.equal((await active.stop()).status, 200);
  assert.equal((await committed.response()).status, 409);
  assert.equal(listBookings().length, 1);
  const expiring = ticketedCall();
  assert.equal((await expiring.start()).status, 200);
  const originalNow = Date.now;
  const started = Date.now();
  Date.now = () => started + 3_600_001;
  try {
    assert.equal((await expiring.send("我要预约").response()).status, 409);
  } finally {
    Date.now = originalNow;
  }
});

test("user item IDs cannot collide with start and stop control events", async () => {
  const call = ticketedCall();
  const initial = await (await call.start()).json();
  const startNamedTurn = await call
    .send("我要预约", undefined, undefined, "start")
    .response();
  assert.equal(startNamedTurn.status, 200);
  assert.equal((await startNamedTurn.json()).context.step, "date");
  const stopNamedTurn = await call
    .send("2099年12月1日", undefined, undefined, "stop")
    .response();
  assert.equal(stopNamedTurn.status, 200);
  assert.equal((await stopNamedTurn.json()).context.step, "hour");
  assert.deepEqual(await (await call.start()).json(), initial);
  const stopped = await call.stop();
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).closed, true);
  assert.equal((await call.send("一号球场").response()).status, 409);
  assert.equal(listBookings().length, 0);
});

test("an external callback that changes the voice form makes the Realtime session stale", async () => {
  const call = ticketedCall();
  await call.start();
  handleVoice(call.callSid, PHONE, call.state().turn, "", "我要预约");
  const advanced = getChannelState(`voice:${call.callSid}`);
  assert.equal(call.state().step, "date");
  const stale = await call.send("2099年12月1日").response();
  assert.equal(stale.status, 409);
  assert.equal(getChannelState(`voice:${call.callSid}`), advanced);
  assert.equal(listBookings().length, 0);
});

test("turns are call-bound and malformed payloads or invented names never enter the form", async () => {
  const call = ticketedCall();
  await call.start();
  const crossCall = call.send("我要预约").body;
  assert.equal(
    (
      await realtimeTurn(
        internalRequest({
          ...crossCall,
          callSid: identifier("CA"),
        }),
      )
    ).status,
    403,
  );
  const malformed = [
    { ...crossCall, op: "unknown" },
    { ...crossCall, transcript: 123 },
    { ...crossCall, transcript: "x".repeat(16_385) },
    { ...crossCall, inputId: "../invalid" },
    { ...crossCall, digits: "not-digits" },
    { ...crossCall, interpretation: { scope: "booking", confirm: true } },
    {
      ...crossCall,
      interpretation: { ...understanding(), scope: ["booking"] },
    },
    { ...crossCall, interpretation: { ...understanding(), action: ["book"] } },
    {
      ...crossCall,
      interpretation: { ...understanding(), correction: ["hour"] },
    },
    { ...crossCall, interpretation: understanding({ date: "2099-02-30" }) },
    { ...crossCall, interpretation: understanding({ name: "凭空名字" }) },
  ];
  for (const body of malformed) {
    const response = await realtimeTurn(internalRequest(body));
    assert.ok(
      [400, 413].includes(response.status),
      `expected bounded validation; got ${response.status}`,
    );
  }
  assert.equal(call.state().step, "menu");
  assert.equal(listBookings().length, 0);
  const badJson = internalRequest({});
  const broken = new Request(badJson, { body: "{broken" });
  assert.equal((await realtimeTurn(broken)).status, 400);
});
