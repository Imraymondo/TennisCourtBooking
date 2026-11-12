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
  assert.match(contact.prompt, /联系电话/);
  assert.equal(call.state().step, "contact");
  const summary = await call.send("使用来电号码").response();
  assert.equal(summary.status, 200);
  assert.match((await summary.json()).prompt, /预约人张三/);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  return call;
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
  assert.match(result.prompt, /预约/);
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
  assert.match(result.prompt, /预约成功/);
  assert.match(result.prompt, /预约编号/);
  assert.match(result.prompt, /管理码/);
  assert.doesNotMatch(result.prompt, /<Say|<Gather|&amp;|&lt;/);
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.phone, PHONE);
  assert.equal(booking.source, "phone");
  assert.equal(booking.courtId, 2);
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
  assert.match(result.prompt, /预约人O'Neil/);
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
  assert.equal((await stopNamedTurn.json()).context.step, "court");
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
