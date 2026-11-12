import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { after, beforeEach, test, type TestContext } from "node:test";
import {
  claimPhoneBookingSmsOutbox,
  closeDatabase,
  createBooking,
  getBooking,
  getDatabase,
  getPhoneBookingSmsOutbox,
  listBookings,
  runChannelEvent,
} from "../lib/store";
import {
  finalizePhoneBookingSms,
  PHONE_SMS_PENDING_PROMPT,
  phoneSmsPendingPrompt,
  queuePhoneBookingSms,
} from "../lib/channels/phone-sms";
import { spokenAccessCode } from "../lib/channels/voice-speech";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const MESSAGE_SID = `SM${"b".repeat(32)}`;
const AUTH_TOKEN = "fake-test-only-twilio-token";
const SENDER = "+61255550100";

beforeEach(() => {
  closeDatabase();
  Object.assign(process.env, {
    BOOKING_DB_PATH: ":memory:",
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: SENDER,
  });
});
after(closeDatabase);

type CapturedRequest = {
  url: string;
  options: https.RequestOptions;
  body: URLSearchParams;
};

function fakeProvider(
  t: TestContext,
  options: {
    status?: number;
    body?: string;
    behavior?: "error" | "timeout" | "throw";
  } = {},
) {
  const calls: CapturedRequest[] = [];
  t.mock.method(
    https,
    "request",
    (
      url: string,
      requestOptions: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      assert.equal(
        getDatabase().isTransaction,
        false,
        "send starts after commit",
      );
      if (options.behavior === "throw")
        throw new Error("private provider error");
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
        destroy: () => void;
      };
      request.destroy = () => request.emit("error", new Error("socket closed"));
      request.end = (body) => {
        calls.push({
          url,
          options: requestOptions,
          body: new URLSearchParams(body),
        });
        if (options.behavior === "timeout") return;
        queueMicrotask(() => {
          if (options.behavior === "error") {
            request.emit("error", new Error("private transport error"));
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
          };
          let destroyed = false;
          response.destroy = () => {
            destroyed = true;
          };
          response.statusCode = options.status ?? 201;
          callback(response);
          if (destroyed) return;
          response.emit(
            "data",
            Buffer.from(
              options.body ??
                JSON.stringify({ sid: MESSAGE_SID, status: "queued" }),
            ),
          );
          if (!destroyed) response.emit("end");
        });
      };
      return request;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}

function confirmed(
  phone = "0412 345 678",
  callSid = `CA${randomUUID().replaceAll("-", "")}`,
  startLocal = "2099-12-01T15:00",
) {
  let queued = false;
  const created = runChannelEvent(`confirmed:${callSid}:${startLocal}`, () => {
    const result = createBooking({
      courtId: 1,
      startLocal,
      durationHours: 2,
      customerName: "短信球友 <A&B>",
      phone,
      source: "phone",
    });
    queued = queuePhoneBookingSms(callSid, result);
    return result;
  });
  return { callSid, queued, ...created };
}

test("missing or invalid outbound configuration keeps the booking and makes no request", async (t) => {
  const calls = fakeProvider(t);
  for (const [key, value] of [
    ["TWILIO_ACCOUNT_SID", ""],
    ["TWILIO_ACCOUNT_SID", "ACnot-an-account"],
    ["TWILIO_ACCOUNT_SID", ` ${ACCOUNT_SID} `],
    ["TWILIO_AUTH_TOKEN", ""],
    ["TWILIO_PHONE_NUMBER", "0412345678"],
  ]) {
    closeDatabase();
    Object.assign(process.env, {
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: SENDER,
      [key]: value,
    });
    const valueCreated = confirmed();
    assert.equal(valueCreated.queued, false);
    assert.equal(
      getPhoneBookingSmsOutbox(valueCreated.callSid, valueCreated.booking.id),
      null,
    );
    assert.equal(
      getBooking(valueCreated.booking.id, valueCreated.accessCode).status,
      "confirmed",
    );
    assert.equal(
      await finalizePhoneBookingSms(
        valueCreated.callSid,
        "预约成功。请保管预约详情。",
      ),
      "预约成功。请保管预约详情。",
    );
  }
  assert.equal(calls.length, 0);
});

test("queue requires an existing confirmed phone creation and a usable confirmed contact", (t) => {
  const calls = fakeProvider(t);
  const result = confirmed("123456");
  assert.equal(
    result.queued,
    false,
    "ambiguous contact does not use a caller fallback",
  );
  assert.equal(
    getPhoneBookingSmsOutbox(result.callSid, result.booking.id),
    null,
  );
  assert.equal(
    queuePhoneBookingSms(result.callSid, {
      ...result,
      booking: { ...result.booking, id: "99999999" },
    }),
    false,
  );
  const web = createBooking({
    courtId: 2,
    startLocal: "2099-12-01T15:00",
    customerName: "网页球友",
    phone: "+61412345678",
    source: "web",
  });
  assert.equal(queuePhoneBookingSms("CA-web", web), false);
  assert.equal(calls.length, 0);
});

test("committed queue submits one private receipt to the selected AU contact and persists the Twilio SID", async (t) => {
  const calls = fakeProvider(t);
  const value = confirmed();
  assert.equal(value.queued, true);
  assert.equal(
    calls.length,
    0,
    "queueing is synchronous and performs no network IO",
  );
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "pending",
  );
  const [first, duplicate] = await Promise.all([
    finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
    finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
  ]);
  assert.equal(first, PHONE_SMS_PENDING_PROMPT);
  assert.equal(duplicate, first);
  assert.equal(
    await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
    first,
  );
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(
    request.url,
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.agent instanceof https.Agent, true);
  const headers = request.options.headers as Record<string, string | number>;
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
  );
  assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(request.body.get("From"), SENDER);
  assert.equal(request.body.get("To"), "+61412345678");
  assert.deepEqual([...request.body.keys()].sort(), ["Body", "From", "To"]);
  const body = request.body.get("Body")!;
  assert.match(body, /一号球场/);
  assert.match(body, /2099-12-01 15:00至2099-12-01 17:00/);
  assert.match(body, /共2小时/);
  assert.ok(body.includes(value.booking.customerName));
  assert.ok(body.includes(value.booking.id));
  assert.ok(body.includes(value.accessCode));
  const outbox = getPhoneBookingSmsOutbox(value.callSid, value.booking.id)!;
  assert.equal(outbox.id, `phone-booking:${value.booking.id}:created`);
  assert.equal(outbox.status, "submitted");
  assert.equal(outbox.messageSid, MESSAGE_SID);
  assert.equal(outbox.body, body);
  assert.equal(queuePhoneBookingSms(value.callSid, value), true);
  assert.equal(queuePhoneBookingSms("CA-another-call", value), false);
  assert.equal(
    getDatabase()
      .prepare("SELECT count(*) AS n FROM phone_booking_sms_outbox")
      .get()?.n,
    1,
  );
});

test("explicit international prefixes are canonicalized while E164 stays intact", async (t) => {
  const calls = fakeProvider(t);
  for (const [phone, expected] of [
    ["0044 7700 900123", "+447700900123"],
    ["+1 (415) 555-0123", "+14155550123"],
  ]) {
    closeDatabase();
    const value = confirmed(phone);
    assert.equal(value.queued, true);
    await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    );
    assert.equal(calls.at(-1)?.body.get("To"), expected);
  }
  assert.equal(calls.length, 2);
});

test("unrelated turns do not send a pending notification; a later replay can recover pending after a crash", async (t) => {
  const calls = fakeProvider(t);
  const value = confirmed();
  assert.equal(
    await finalizePhoneBookingSms(value.callSid, "还需要其他帮助吗？"),
    "还需要其他帮助吗？",
  );
  assert.equal(calls.length, 0);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "pending",
  );
  await finalizePhoneBookingSms(
    value.callSid,
    phoneSmsPendingPrompt(value.booking.id),
  );
  assert.equal(calls.length, 1);
});

test("cached prompts remain bound to their own booking when a call creates a second booking", async (t) => {
  const calls = fakeProvider(t, { status: 400 });
  const first = confirmed("0412 345 678");
  const second = confirmed("0499 123 456", first.callSid, "2099-12-01T18:00");
  const firstPrompt = phoneSmsPendingPrompt(first.booking.id);
  const firstReceipt = await finalizePhoneBookingSms(
    first.callSid,
    firstPrompt,
  );
  assert.ok(firstReceipt.includes(spokenAccessCode(first.booking.id)));
  assert.ok(firstReceipt.includes(spokenAccessCode(first.accessCode)));
  assert.ok(!firstReceipt.includes(spokenAccessCode(second.booking.id)));
  assert.ok(!firstReceipt.includes(spokenAccessCode(second.accessCode)));
  assert.equal(calls[0].body.get("To"), "+61412345678");
  assert.equal(
    getPhoneBookingSmsOutbox(second.callSid, second.booking.id)?.status,
    "pending",
  );
  await finalizePhoneBookingSms(
    second.callSid,
    phoneSmsPendingPrompt(second.booking.id),
  );
  assert.equal(calls[1].body.get("To"), "+61499123456");
  assert.equal(
    await finalizePhoneBookingSms(first.callSid, firstPrompt),
    firstReceipt,
  );
  assert.equal(calls.length, 2);
});

test("a bare or differently bound marker never guesses which pending receipt to send", async (t) => {
  const calls = fakeProvider(t);
  const value = confirmed();
  assert.equal(
    await finalizePhoneBookingSms(value.callSid, PHONE_SMS_PENDING_PROMPT),
    "预约成功，短信发送状态未确认。",
  );
  assert.equal(
    await finalizePhoneBookingSms(
      "CA-unrelated",
      phoneSmsPendingPrompt(value.booking.id),
    ),
    "预约成功，短信发送状态未确认。",
  );
  assert.equal(calls.length, 0);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "pending",
  );
});

test("a queued receipt uses the stored confirmed contact even if an input snapshot is changed", async (t) => {
  const calls = fakeProvider(t);
  const value = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T15:00",
    customerName: "球友",
    phone: "0499 123 456",
    source: "phone",
  });
  assert.equal(
    queuePhoneBookingSms("CA-confirmed-contact", {
      ...value,
      booking: { ...value.booking, phone: "+61400123456" },
    }),
    true,
  );
  await finalizePhoneBookingSms(
    "CA-confirmed-contact",
    phoneSmsPendingPrompt(value.booking.id),
  );
  assert.equal(calls[0].body.get("To"), "+61499123456");
});

test("booking and queue roll back together before commit, with no SMS", async (t) => {
  const calls = fakeProvider(t);
  let callSid = "";
  let bookingId = "";
  assert.throws(() =>
    runChannelEvent("rollback-create", () => {
      const value = confirmed();
      callSid = value.callSid;
      bookingId = value.booking.id;
      assert.equal(value.queued, true);
      throw new Error("rollback fixture");
    }),
  );
  assert.equal(listBookings().length, 0);
  assert.equal(getPhoneBookingSmsOutbox(callSid, bookingId), null);
  await finalizePhoneBookingSms(callSid, PHONE_SMS_PENDING_PROMPT);
  assert.equal(calls.length, 0);
});

test("outbox storage failure does not roll back a successful booking", (t) => {
  const calls = fakeProvider(t);
  const result = runChannelEvent("outbox-unavailable", () => {
    const value = createBooking({
      courtId: 1,
      startLocal: "2099-12-01T15:00",
      customerName: "球友",
      phone: "+61412345678",
      source: "phone",
    });
    getDatabase().exec("DROP TABLE phone_booking_sms_outbox");
    assert.equal(queuePhoneBookingSms("CA-outbox-unavailable", value), false);
    return value;
  });
  assert.equal(
    getBooking(result.booking.id, result.accessCode).status,
    "confirmed",
  );
  assert.equal(calls.length, 0);
});

test("HTTP rejection gives one spoken receipt without rolling back the booking, including on XML replay", async (t) => {
  const calls = fakeProvider(t, { status: 400, body: "private provider body" });
  const value = confirmed();
  const xml = `<Response><Say>${phoneSmsPendingPrompt(value.booking.id)}</Say></Response>`;
  const result = await finalizePhoneBookingSms(value.callSid, xml);
  assert.match(result, /预约成功，短信暂时发送不了/);
  assert.equal((result.match(/预约编号：/g) || []).length, 1);
  assert.equal((result.match(/管理码：/g) || []).length, 1);
  assert.ok(result.includes(spokenAccessCode(value.booking.id)));
  assert.ok(result.includes(spokenAccessCode(value.accessCode)));
  assert.ok(!result.includes("private provider"));
  assert.ok(!result.includes(PHONE_SMS_PENDING_PROMPT));
  assert.equal(await finalizePhoneBookingSms(value.callSid, xml), result);
  assert.equal(calls.length, 1);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "failed",
  );
  assert.equal(
    getBooking(value.booking.id, value.accessCode).status,
    "confirmed",
  );
  const gather = `<Gather><Say>${phoneSmsPendingPrompt(value.booking.id)}</Say></Gather>`;
  const gatherReceipt = await finalizePhoneBookingSms(value.callSid, gather);
  assert.match(gatherReceipt, /^<Gather><Say>预约成功，短信暂时发送不了/);
  assert.match(gatherReceipt, /<\/Say><\/Gather>$/);
  assert.ok(!gatherReceipt.includes("<A&B>"));
  assert.equal(calls.length, 1);
});

for (const scenario of [
  { name: "network error", behavior: "error" as const },
  { name: "invalid success JSON", body: "private malformed provider response" },
  { name: "success without SID", body: JSON.stringify({ status: "queued" }) },
  { name: "oversized response", body: "a".repeat(65_537) },
  { name: "server error", status: 500 },
]) {
  test(`${scenario.name} is uncertain and never retried on replay`, async (t) => {
    const calls = fakeProvider(t, scenario);
    const value = confirmed();
    const result = await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    );
    assert.match(result, /预约成功，短信发送状态未确认/);
    assert.equal((result.match(/管理码：/g) || []).length, 1);
    assert.equal(
      getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
      "unknown",
    );
    assert.equal(
      await finalizePhoneBookingSms(
        value.callSid,
        phoneSmsPendingPrompt(value.booking.id),
      ),
      result,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      getBooking(value.booking.id, value.accessCode).status,
      "confirmed",
    );
  });
}

test("the total send timeout is four seconds and remains uncertain on replay", async (t) => {
  const calls = fakeProvider(t, { behavior: "timeout" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const value = confirmed();
  const sending = finalizePhoneBookingSms(
    value.callSid,
    phoneSmsPendingPrompt(value.booking.id),
  );
  t.mock.timers.tick(3_999);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "processing",
  );
  t.mock.timers.tick(1);
  const result = await sending;
  assert.match(result, /短信发送状态未确认/);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "unknown",
  );
  assert.equal(
    await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
    result,
  );
  assert.equal(calls.length, 1);
});

test("another process's persistent claim prevents a second send; expired claims become unknown", async (t) => {
  const calls = fakeProvider(t);
  const value = confirmed();
  const id = getPhoneBookingSmsOutbox(value.callSid, value.booking.id)!.id;
  assert.equal(claimPhoneBookingSmsOutbox(id), true);
  assert.equal(claimPhoneBookingSmsOutbox(id), false);
  assert.equal(
    await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
    PHONE_SMS_PENDING_PROMPT,
  );
  assert.equal(calls.length, 0);
  getDatabase()
    .prepare("UPDATE phone_booking_sms_outbox SET updated_at = ? WHERE id = ?")
    .run(Date.now() - 31_000, id);
  const result = await finalizePhoneBookingSms(
    value.callSid,
    phoneSmsPendingPrompt(value.booking.id),
  );
  assert.match(result, /短信发送状态未确认/);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "unknown",
  );
  assert.equal(
    await finalizePhoneBookingSms(
      value.callSid,
      phoneSmsPendingPrompt(value.booking.id),
    ),
    result,
  );
  assert.equal(calls.length, 0);
});

test("removed configuration after queue fails safely without sending or rolling back", async (t) => {
  const calls = fakeProvider(t);
  const value = confirmed();
  process.env.TWILIO_ACCOUNT_SID = "";
  const result = await finalizePhoneBookingSms(
    value.callSid,
    phoneSmsPendingPrompt(value.booking.id),
  );
  assert.match(result, /预约成功，短信暂时发送不了/);
  assert.equal(calls.length, 0);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "failed",
  );
  assert.equal(
    getBooking(value.booking.id, value.accessCode).status,
    "confirmed",
  );
});

test("synchronous request setup errors are uncertain without leaving a timeout running", async (t) => {
  const calls = fakeProvider(t, { behavior: "throw" });
  const value = confirmed();
  const result = await finalizePhoneBookingSms(
    value.callSid,
    phoneSmsPendingPrompt(value.booking.id),
  );
  assert.match(result, /短信发送状态未确认/);
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "unknown",
  );
  assert.equal(calls.length, 0);
});

test("completion storage failure preserves one usable spoken receipt and the persistent claim prevents retry", async (t) => {
  const calls = fakeProvider(t, { behavior: "error" });
  const value = confirmed();
  getDatabase().exec(`
    CREATE TRIGGER reject_sms_completion
    BEFORE UPDATE OF status ON phone_booking_sms_outbox
    WHEN NEW.status IN ('submitted', 'failed', 'unknown')
    BEGIN
      SELECT RAISE(FAIL, 'fixture rejects completion update');
    END;
  `);
  const prompt = phoneSmsPendingPrompt(value.booking.id);
  const result = await finalizePhoneBookingSms(value.callSid, prompt);
  assert.match(result, /预约成功，短信发送状态未确认/);
  assert.equal((result.match(/预约编号：/g) || []).length, 1);
  assert.equal((result.match(/管理码：/g) || []).length, 1);
  assert.ok(result.includes(spokenAccessCode(value.booking.id)));
  assert.ok(result.includes(spokenAccessCode(value.accessCode)));
  assert.equal(
    getBooking(value.booking.id, value.accessCode).status,
    "confirmed",
  );
  assert.equal(
    getPhoneBookingSmsOutbox(value.callSid, value.booking.id)?.status,
    "processing",
  );
  await finalizePhoneBookingSms(value.callSid, prompt);
  assert.equal(calls.length, 1);
  getDatabase()
    .prepare("UPDATE phone_booking_sms_outbox SET updated_at = ? WHERE id = ?")
    .run(Date.now() - 31_000, `phone-booking:${value.booking.id}:created`);
  const expiredReplay = await finalizePhoneBookingSms(value.callSid, prompt);
  assert.equal(
    expiredReplay,
    result,
    "expired-claim persistence failure retains the known receipt too",
  );
  assert.equal(calls.length, 1);
});
