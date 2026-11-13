import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { POST as realtimeTurn } from "../app/api/realtime/turn/route";
import { POST as voice } from "../app/api/webhooks/voice/route";
import type { BookingInterpretation } from "../lib/channels/booking-ai";
import { PHONE_SMS_PENDING_PROMPT } from "../lib/channels/phone-sms";
import { createRealtimeVoice } from "../lib/channels/realtime";
import {
  closeDatabase,
  getBooking,
  getChannelState,
  getDatabase,
  getPhoneBookingSmsOutbox,
  listBookings,
} from "../lib/store";
import { spokenCredential } from "./spoken-credential";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const MESSAGE_SID = `SM${"b".repeat(32)}`;
const AUTH_TOKEN = "fake-test-only-route-signature-token";
const SENDER = "+61255550100";
const CALLER = "+61400123456";
const WEBHOOK_URL = "https://courts.example/api/webhooks/voice";
const TEST_ENVIRONMENT = {
  BOOKING_DB_PATH: ":memory:",
  APP_BASE_URL: "https://courts.example",
  BOOKING_AI_ENABLED: "0",
  VOICE_DEBUG: "0",
  VOICE_MODE: "gather",
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: SENDER,
  OPENAI_API_KEY: "fake-test-only-route-openai-key",
  REALTIME_BRIDGE_SECRET: "fake-test-only-route-bridge-secret",
};
let originalEnvironment: Record<string, string | undefined>;

beforeEach((t) => {
  if ("mock" in t) t.mock.restoreAll();
  syncBuiltinESMExports();
  closeDatabase();
  originalEnvironment = Object.fromEntries(
    Object.keys(TEST_ENVIRONMENT).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, TEST_ENVIRONMENT);
});
afterEach((t) => {
  if ("mock" in t) t.mock.restoreAll();
  syncBuiltinESMExports();
  closeDatabase();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type CapturedSms = {
  url: string;
  options: https.RequestOptions;
  body: URLSearchParams;
  transactionOpen: boolean;
  committedBookingIds: string[];
};

function fakeProvider(t: TestContext, status = 201) {
  const calls: CapturedSms[] = [];
  t.mock.method(
    https,
    "request",
    (
      url: string,
      options: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      const transactionOpen = getDatabase().isTransaction;
      const committedBookingIds = listBookings().map((booking) => booking.id);
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
        destroy: () => void;
      };
      request.destroy = () =>
        request.emit("error", new Error("fake socket closed"));
      request.end = (body) => {
        calls.push({
          url,
          options,
          body: new URLSearchParams(body),
          transactionOpen,
          committedBookingIds,
        });
        // Keep submission in flight while an identical callback enters the route.
        setImmediate(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
          };
          let destroyed = false;
          response.statusCode = status;
          response.destroy = () => {
            destroyed = true;
          };
          callback(response);
          if (!destroyed) {
            response.emit(
              "data",
              Buffer.from(JSON.stringify({ sid: MESSAGE_SID })),
            );
            response.emit("end");
          }
        });
      };
      return request;
    },
  );
  syncBuiltinESMExports();
  return calls;
}

function signedRequest(url: string, fields: Record<string, string>) {
  const material =
    url +
    Object.keys(fields)
      .sort()
      .map((key) => key + fields[key])
      .join("");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": createHmac("sha1", AUTH_TOKEN)
        .update(material)
        .digest("base64"),
    },
    body: new URLSearchParams(fields),
  });
}

function gatherCall() {
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;
  let url = WEBHOOK_URL;
  const prepare = (speech = "", digits = "") => {
    const target = url;
    const fields = {
      CallSid: callSid,
      To: SENDER,
      From: CALLER,
      SpeechResult: speech,
      Digits: digits,
    };
    return () => voice(signedRequest(target, fields));
  };
  return {
    callSid,
    prepare,
    state: () => JSON.parse(getChannelState(`voice:${callSid}`)!),
    say: async (speech = "") => {
      const response = await prepare(speech)();
      assert.equal(response.status, 200);
      const xml = await response.text();
      const action = xml.match(/action="([^"]+)"/)?.[1];
      assert.ok(action, "Gather response supplies its next callback URL");
      url = action.replaceAll("&amp;", "&");
      return xml;
    },
  };
}

function assertUncommitted(calls: CapturedSms[]) {
  assert.equal(
    listBookings().length,
    0,
    "no booking before explicit confirmation",
  );
  assert.equal(calls.length, 0, "no SMS before explicit confirmation");
}

async function pendingGather(calls: CapturedSms[]) {
  const call = gatherCall();
  for (const speech of [
    "",
    "我要预约",
    "2099年12月1日",
    "下午三点",
    "两个小时",
  ]) {
    const reply = await call.say(speech);
    assert.notEqual(call.state().step, "court");
    assert.doesNotMatch(reply, /请选择一号或二号|想订一号场还是二号场/);
    assertUncommitted(calls);
  }
  assert.equal(call.state().step, "name");
  await call.say("我叫张三");
  assert.equal(call.state().step, "contact");
  assertUncommitted(calls);
  const summary = await call.say("我的电话是零四一二三四五六七八");
  assert.equal(call.state().step, "confirm");
  assert.match(summary, /张三/);
  assert.equal(call.state().contactPhone, "0412345678");
  assertUncommitted(calls);
  return call;
}

function assertReceipt(
  callSid: string,
  request: CapturedSms,
  recipient: string,
) {
  const [booking] = listBookings();
  assert.ok(booking);
  assert.equal(booking.source, "phone");
  assert.equal(booking.status, "confirmed");
  assert.equal(
    request.transactionOpen,
    false,
    "provider request begins after commit",
  );
  assert.deepEqual(request.committedBookingIds, [booking.id]);
  assert.equal(
    request.url,
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
  );
  assert.equal(request.options.method, "POST");
  const headers = request.options.headers as Record<string, string>;
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
  );
  assert.equal(request.body.get("From"), SENDER);
  assert.equal(request.body.get("To"), recipient);
  const outbox = getPhoneBookingSmsOutbox(callSid, booking.id)!;
  assert.ok(outbox);
  const body = request.body.get("Body")!;
  assert.equal(body, outbox.body);
  assert.ok(body.includes(booking.customerName));
  assert.ok(body.includes(`Booking reference: ${booking.id}.`));
  assert.ok(body.includes(`Access code: ${outbox.accessCode}.`));
  assert.equal(getBooking(booking.id, outbox.accessCode).id, booking.id);
  return { booking, outbox, body };
}

test("Gather confirmation sends its committed receipt to the reviewed contact exactly once across concurrent callbacks and replay", async (t) => {
  const calls = fakeProvider(t);
  const call = await pendingGather(calls);
  const confirm = call.prepare("确认预约");
  const responses = await Promise.all([confirm(), confirm()]);
  for (const response of responses) assert.equal(response.status, 200);
  const [xml, duplicateXml] = await Promise.all(
    responses.map((response) => response.text()),
  );
  assert.equal(duplicateXml, xml);
  assert.equal(listBookings().length, 1);
  assert.equal(calls.length, 1);
  const { booking, outbox, body } = assertReceipt(
    call.callSid,
    calls[0],
    "+61412345678",
  );
  assert.equal(booking.phone, "0412345678");
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.courtId, 1);
  assert.equal(booking.durationHours, 2);
  assert.equal(booking.startsAt, "2099-12-01T04:00:00Z");
  assert.match(body, /Court 1/);
  assert.match(body, /2099-12-01 15:00 to 2099-12-01 17:00/);
  assert.match(body, /2 hours/);
  assert.equal(outbox.status, "submitted");
  assert.equal(outbox.messageSid, MESSAGE_SID);
  assert.ok(xml.includes(PHONE_SMS_PENDING_PROMPT));
  assert.doesNotMatch(
    xml,
    /Booking reference|Access code|SMS could not be sent/i,
  );
  assert.ok(!xml.includes(booking.id));
  assert.ok(!xml.includes(outbox.accessCode));
  assert.equal(await (await confirm()).text(), xml);
  assert.equal(calls.length, 1);
  assert.equal(listBookings().length, 1);
  assert.equal(
    getDatabase()
      .prepare("SELECT count(*) AS n FROM phone_booking_sms_outbox")
      .get()?.n,
    1,
  );
});

test("a rejected Gather SMS keeps the booking and reads each usable fallback credential once without resending on retry", async (t) => {
  const calls = fakeProvider(t, 400);
  const call = await pendingGather(calls);
  const confirm = call.prepare("确认预约");
  const response = await confirm();
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.equal(calls.length, 1);
  assert.equal(listBookings().length, 1);
  const { booking, outbox } = assertReceipt(
    call.callSid,
    calls[0],
    "+61412345678",
  );
  assert.equal(outbox.status, "failed");
  assert.match(xml, /Booking confirmed; the SMS could not be sent/);
  assert.equal([...xml.matchAll(/Booking reference:/g)].length, 1);
  assert.equal([...xml.matchAll(/Access code:/g)].length, 1);
  assert.equal(spokenCredential(xml, "Booking reference"), booking.id);
  assert.equal(spokenCredential(xml), outbox.accessCode);
  assert.equal(
    getBooking(booking.id, spokenCredential(xml)).status,
    "confirmed",
  );
  assert.doesNotMatch(
    xml,
    /confirmation SMS is being sent|fake-test-only|Basic /,
  );
  assert.equal(await (await confirm()).text(), xml);
  assert.equal(calls.length, 1);
  assert.equal(listBookings().length, 1);
});

test("the private Realtime route finalizes SMS after confirmation and returns a short native receipt without credentials", async (t) => {
  process.env.VOICE_MODE = "realtime";
  const calls = fakeProvider(t);
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;
  const streamSid = `MS${randomUUID().replaceAll("-", "")}`;
  const xml = createRealtimeVoice(callSid, CALLER);
  const ticket = xml.match(/name="ticket" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(ticket);
  const post = (body: unknown) =>
    realtimeTurn(
      new Request("http://127.0.0.1:3000/api/realtime/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.REALTIME_BRIDGE_SECRET}`,
        },
        body: JSON.stringify(body),
      }),
    );
  const start = await post({ op: "start", callSid, streamSid, ticket });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).context.step, "menu");
  const turn = (
    transcript: string,
    interpretation?: BookingInterpretation,
  ) => ({
    op: "turn",
    callSid,
    streamSid,
    inputId: `item_${randomUUID().replaceAll("-", "")}`,
    transcript,
    ...(interpretation ? { interpretation } : {}),
  });
  const collect = await post(
    turn("帮我预约2099年12月1日下午三点二号场打三个小时，我叫李四", {
      scope: "booking",
      action: "book",
      date: "2099-12-01",
      court: 2,
      hour: "15",
      duration: 3,
      name: "李四",
      correction: null,
    }),
  );
  assert.equal(collect.status, 200);
  assert.equal((await collect.json()).context.step, "contact");
  assertUncommitted(calls);
  const contact = await post(turn("使用来电号码"));
  assert.equal(contact.status, 200);
  const summary = await contact.json();
  assert.equal(summary.context.step, "confirm");
  assert.match(summary.prompt, /李四/);
  assertUncommitted(calls);
  const confirmation = turn("确认预约");
  const response = await post(confirmation);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(calls.length, 1);
  assert.equal(listBookings().length, 1);
  const { booking, outbox, body } = assertReceipt(callSid, calls[0], CALLER);
  assert.equal(booking.phone, CALLER);
  assert.equal(booking.customerName, "李四");
  assert.equal(booking.courtId, 1);
  assert.equal(booking.durationHours, 3);
  assert.match(body, /Court 1/);
  assert.match(body, /2099-12-01 15:00 to 2099-12-01 18:00/);
  assert.equal(outbox.status, "submitted");
  assert.equal(result.context.step, "menu");
  assert.ok(result.prompt.includes(PHONE_SMS_PENDING_PROMPT));
  assert.doesNotMatch(
    result.prompt,
    /Booking reference|Access code|<Say|<Response/,
  );
  assert.ok(!result.prompt.includes(booking.id));
  assert.ok(!result.prompt.includes(outbox.accessCode));
  assert.deepEqual(await (await post(confirmation)).json(), result);
  assert.equal(calls.length, 1);
  assert.equal(listBookings().length, 1);
});
