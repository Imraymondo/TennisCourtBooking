import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { after, beforeEach, test } from "node:test";
import { POST as voice } from "../app/api/webhooks/voice/route";
import type { BookingInterpretation } from "../lib/channels/booking-ai";
import {
  handleVoice,
  voiceAIContext,
  voiceProgress,
} from "../lib/channels/voice";
import {
  closeDatabase,
  createBooking,
  getChannelState,
  listBookings,
  runChannelEvent,
} from "../lib/store";

beforeEach(() => {
  process.env.VOICE_MODE = "gather";
  process.env.TWILIO_ACCOUNT_SID = "";
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.BOOKING_AI_ENABLED = "1";
  process.env.OPENAI_API_KEY = "test-only-voice-ai-key";
  process.env.TWILIO_AUTH_TOKEN = "test-only-voice-ai-signature-key";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
});
after(closeDatabase);

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

function caller() {
  const sid = `CA${randomUUID().replaceAll("-", "")}`;
  const state = () => JSON.parse(getChannelState(`voice:${sid}`)!);
  const send = (
    speech = "",
    interpreted: BookingInterpretation | null = null,
    digits = "",
  ) => {
    const turn = voiceProgress(sid)?.turn || null;
    return runChannelEvent(`voice:${sid}:${turn || "initial"}`, () =>
      handleVoice(sid, "+61400123456", turn, digits, speech, interpreted),
    );
  };
  send();
  return { sid, state, send };
}

function pendingBooking() {
  const call = caller();
  const contact = call.send(
    "帮我安排十二月一号下午三点在二号场打三个小时，我叫张三",
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 2,
      hour: "15",
      duration: 3,
      name: "张三",
    }),
  );
  assert.match(contact, /contact number/i);
  assert.equal(call.state().step, "contact");
  assert.equal(
    call.state().court,
    1,
    "server assignment ignores the requested court when both are free",
  );
  const summary = call.send("使用来电号码");
  assert.match(summary, /Booking name: 张三/i);
  assert.match(summary, /3 hours/);
  assert.match(summary, /name will appear publicly on the website schedule/i);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  return call;
}

test("voice understanding fills several fields while a later raw confirmation owns the database write", () => {
  const call = pendingBooking();
  const summaryTurn = call.state().turn;
  const committed = call.send("确认预约");
  assert.match(committed, /Booking confirmed/i);
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.courtId, 1);
  assert.equal(booking.durationHours, 3);
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.phone, "+61400123456");
  assert.equal(booking.startsAt, "2099-12-01T04:00:00Z");
  const replay = runChannelEvent(`voice:${call.sid}:${summaryTurn}`, () =>
    handleVoice(call.sid, "+61400123456", summaryTurn, "", "确认预约"),
  );
  assert.equal(replay, committed);
  assert.equal(listBookings().length, 1);
});

test("raw denial overrides model fields and never submits a reviewed booking", () => {
  const call = pendingBooking();
  call.send("不确认", understanding({ hour: "18", correction: "hour" }));
  assert.equal(listBookings().length, 0);
  assert.equal(call.state().step, "menu");
});

test("a model court correction keeps the server assignment and still requires raw confirmation", () => {
  const call = pendingBooking();
  call.send("换成二号场", understanding({ court: 2, correction: "court" }));
  assert.equal(call.state().court, 1);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  call.send("确认预约");
  assert.equal(listBookings()[0].courtId, 1);
});

test("a model court preference cannot narrow a phone availability query", () => {
  const call = caller();
  const availability = call.send(
    "查十二月一号二号场三小时空档",
    understanding({
      action: "query",
      date: "2099-12-01",
      court: 2,
      duration: 3,
    }),
  );
  assert.match(availability, /Court 1/);
  assert.match(availability, /Court 2/);
  assert.equal(call.state().step, "menu");
  assert.equal(listBookings().length, 0);
});

test("a model schedule correction is reviewed and needs a new explicit confirmation", () => {
  const call = pendingBooking();
  const revised = call.send(
    "换成晚上六点只打一小时",
    understanding({ hour: "18", duration: 1, correction: "hour" }),
  );
  assert.match(revised, /6(?: to 7)? pm/);
  assert.match(revised, /1 hour/);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
  call.send("确认预约");
  assert.equal(listBookings()[0].startsAt, "2099-12-01T07:00:00Z");
  assert.equal(listBookings()[0].durationHours, 1);
});

test("confirmation and correction in the same utterance cannot commit either schedule", () => {
  const call = pendingBooking();
  call.send(
    "确认预约，修改时间到晚上六点",
    understanding({ hour: "18", correction: "hour" }),
  );
  assert.equal(listBookings().length, 0);
  assert.notEqual(call.state().step, "menu");
  assert.equal(
    voiceAIContext(
      call.sid,
      call.state().turn,
      "",
      "确认预约，修改时间到晚上六点",
    ),
    null,
  );
});

test("model off-topic understanding keeps the caller within tennis booking", () => {
  const call = caller();
  const response = call.send(
    "推荐一部电影",
    understanding({ scope: "off_topic", action: "book", name: "张三" }),
  );
  assert.match(
    response,
    /only help check, create, change or cancel tennis court bookings/i,
  );
  assert.equal(call.state().step, "menu");
  assert.equal(listBookings().length, 0);
});

test("voice AI context contains scheduling fields only and skips credentials, contact, buttons and raw controls", () => {
  const call = pendingBooking();
  const currentTurn = call.state().turn;
  const context = voiceAIContext(call.sid, currentTurn, "", "换成晚上七点");
  assert.ok(context);
  assert.equal(context.channel, "phone");
  assert.equal(context.hour, "15");
  assert.equal(context.court, 1);
  for (const privateField of [
    "name",
    "contactPhone",
    "phone",
    "id",
    "code",
    "version",
    "turn",
  ])
    assert.equal(Object.hasOwn(context, privateField), false, privateField);
  assert.equal(voiceAIContext(call.sid, currentTurn, "1", "换到六点"), null);
  assert.equal(voiceAIContext(call.sid, currentTurn, "", "确认预约"), null);
  assert.equal(voiceAIContext(call.sid, currentTurn, "", "不确认"), null);
  assert.equal(
    voiceAIContext(call.sid, currentTurn, "", "今天天气怎么样"),
    null,
  );
  assert.equal(voiceAIContext(call.sid, currentTurn, "", "退出"), null);
  assert.equal(voiceAIContext(call.sid, randomUUID(), "", "换到六点"), null);

  call.send("修改电话");
  assert.equal(call.state().step, "contact");
  assert.equal(
    voiceAIContext(call.sid, call.state().turn, "", "0412345678"),
    null,
  );
  const management = caller();
  management.send("修改预约");
  assert.equal(management.state().step, "id");
  assert.equal(
    voiceAIContext(management.sid, management.state().turn, "", "12345678"),
    null,
  );
  management.send("12345678");
  assert.equal(management.state().step, "code");
  assert.equal(
    voiceAIContext(management.sid, management.state().turn, "", "1234567890"),
    null,
  );
});

test("a late interpretation for an earlier turn cannot replace the current question or create a booking", () => {
  const call = caller();
  const oldTurn = call.state().turn;
  call.send("我要预约");
  const before = getChannelState(`voice:${call.sid}`);
  const recovery = handleVoice(
    call.sid,
    "+61400123456",
    oldTurn,
    "",
    "安排完整预约",
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 1,
      hour: "16",
      duration: 2,
      name: "李四",
    }),
  );
  assert.match(recovery, /answer the current question again/i);
  assert.equal(getChannelState(`voice:${call.sid}`), before);
  assert.equal(listBookings().length, 0);
});

test("invalid model schedule fields cannot bypass the store's booking rules", () => {
  const call = caller();
  const response = call.send(
    "帮我安排一个球场",
    understanding({
      action: "book",
      date: "2099-02-30",
      court: 2,
      hour: "25",
      duration: 9,
      name: "张三",
    }),
  );
  assert.equal(listBookings().length, 0);
  assert.doesNotMatch(response, /confirm booking/i);
});

test("server assignment uses court two when court one cannot fit the full modeled interval", () => {
  createBooking({
    courtId: 1,
    startLocal: "2099-12-01T17:00",
    durationHours: 1,
    customerName: "已有预约人",
    phone: "+61400999999",
    source: "web",
  });
  const call = caller();
  const contact = call.send(
    "安排一号球场下午三点开始打三个小时，我叫张三",
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 1,
      hour: "15",
      duration: 3,
      name: "张三",
    }),
  );
  assert.equal(listBookings().length, 1);
  assert.equal(call.state().court, 2);
  assert.equal(call.state().step, "contact");
  assert.match(contact, /contact number/i);
  const review = call.send("使用来电号码");
  assert.match(review, /Court 2/);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 1);
  call.send("确认预约");
  const created = listBookings().find((booking) => booking.source === "phone")!;
  assert.equal(created.courtId, 2);
  assert.equal(created.startsAt, "2099-12-01T04:00:00Z");
  assert.equal(created.durationHours, 3);
});

test("when neither court fits the modeled interval the caller must choose a new start time", () => {
  for (const courtId of [1, 2]) {
    createBooking({
      courtId,
      startLocal: "2099-12-01T17:00",
      durationHours: 1,
      customerName: "已有预约人",
      phone: "+61400999999",
      source: "web",
    });
  }
  const call = caller();
  const unavailable = call.send(
    "下午三点打三个小时",
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 2,
      hour: "15",
      duration: 3,
    }),
  );
  assert.equal(call.state().step, "hour");
  assert.equal(call.state().hour, undefined);
  assert.match(unavailable, /Neither court is available for the full booking/i);
  assert.equal(listBookings().length, 2);
});

const WEBHOOK = "https://courts.example/api/webhooks/voice";

function signedRequest(sid: string, turn: string | null, speech: string) {
  const url = turn ? `${WEBHOOK}?turn=${turn}` : WEBHOOK;
  const fields = {
    CallSid: sid,
    To: process.env.TWILIO_PHONE_NUMBER!,
    From: "+61400123456",
    SpeechResult: speech,
    Digits: "",
  };
  const material =
    url +
    Object.keys(fields)
      .sort()
      .map((key) => key + fields[key as keyof typeof fields])
      .join("");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
        .update(material)
        .digest("base64"),
    },
    body: new URLSearchParams(fields),
  });
}

function mockUnderstandingRequest(result: BookingInterpretation, hang = false) {
  const original = https.request;
  let calls = 0;
  let sentBody = "";
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  https.request = ((_options: unknown, ...args: unknown[]) => {
    calls += 1;
    const receive = args.find((value) => typeof value === "function") as
      | ((response: IncomingMessage) => void)
      | undefined;
    const outgoing = Object.assign(new EventEmitter(), {
      write(chunk: string | Buffer) {
        sentBody += chunk.toString();
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk) sentBody += chunk.toString();
        release = () => {
          const incoming = Object.assign(new EventEmitter(), {
            statusCode: 200,
            setEncoding() {
              return incoming;
            },
            resume() {
              return incoming;
            },
          });
          receive?.(incoming as unknown as IncomingMessage);
          incoming.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: JSON.stringify(result) },
                    ],
                  },
                ],
              }),
            ),
          );
          incoming.emit("end");
        };
        reached();
        return outgoing;
      },
      setTimeout(_milliseconds: number, onTimeout?: () => void) {
        if (hang && onTimeout) setTimeout(onTimeout, 20);
        return outgoing;
      },
      destroy(error?: Error) {
        if (error) queueMicrotask(() => outgoing.emit("error", error));
        return outgoing;
      },
    });
    const options = args.find((value) => value && typeof value === "object") as
      | { signal?: AbortSignal }
      | undefined;
    options?.signal?.addEventListener(
      "abort",
      () => {
        outgoing.emit("error", new Error("test request timed out"));
      },
      { once: true },
    );
    return outgoing as unknown as ClientRequest;
  }) as typeof https.request;
  syncBuiltinESMExports();
  return {
    requested,
    release: () => release(),
    calls: () => calls,
    body: () => sentBody,
    restore: () => {
      https.request = original;
      syncBuiltinESMExports();
    },
  };
}

test("duplicate current-turn webhooks share one interpretation and replay identical XML", async () => {
  const mock = mockUnderstandingRequest(
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 2,
      hour: "15",
      duration: 3,
    }),
  );
  try {
    const call = caller();
    const turn = call.state().turn;
    const first = voice(signedRequest(call.sid, turn, "替我安排网球场"));
    const second = voice(signedRequest(call.sid, turn, "替我安排网球场"));
    await mock.requested;
    mock.release();
    const responses = await Promise.all([first, second]);
    assert.equal(responses[0].status, 200);
    assert.equal(responses[1].status, 200);
    const [left, right] = await Promise.all(
      responses.map((response) => response.text()),
    );
    assert.equal(left, right);
    assert.equal(mock.calls(), 1);
    assert.equal(call.state().step, "name");
    const replay = await voice(signedRequest(call.sid, turn, "替我安排网球场"));
    assert.equal(await replay.text(), left);
    assert.equal(mock.calls(), 1);
    assert.equal(listBookings().length, 0);
    assert.doesNotMatch(mock.body(), /61400123456|CallSid|contactPhone/);
  } finally {
    mock.restore();
  }
});

test("the route discards a late interpretation after another callback advances the call", async () => {
  const mock = mockUnderstandingRequest(
    understanding({
      action: "book",
      date: "2099-12-01",
      court: 2,
      hour: "15",
      duration: 3,
    }),
  );
  try {
    const call = caller();
    const turn = call.state().turn;
    const pending = voice(signedRequest(call.sid, turn, "安排一个网球场"));
    await mock.requested;
    handleVoice(call.sid, "+61400123456", turn, "1");
    const advanced = getChannelState(`voice:${call.sid}`);
    assert.equal(call.state().action, "query");
    mock.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer the current question again/i);
    assert.equal(getChannelState(`voice:${call.sid}`), advanced);
    assert.equal(listBookings().length, 0);
  } finally {
    mock.restore();
  }
});

test("invalid webhook signatures are rejected before requesting understanding", async () => {
  const mock = mockUnderstandingRequest(understanding({ action: "book" }));
  try {
    const call = caller();
    const request = signedRequest(
      call.sid,
      call.state().turn,
      "安排一个网球场",
    );
    request.headers.set("x-twilio-signature", "invalid");
    const response = await voice(request);
    assert.equal(response.status, 403);
    assert.equal(mock.calls(), 0);
  } finally {
    mock.restore();
  }
});

test("an interpretation timeout falls back to the existing deterministic voice flow", async () => {
  const mock = mockUnderstandingRequest(
    understanding({ action: "book" }),
    true,
  );
  try {
    const call = caller();
    const started = Date.now();
    const response = await voice(
      signedRequest(call.sid, call.state().turn, "我要预约"),
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /which date/i);
    assert.equal(call.state().step, "date");
    assert.equal(listBookings().length, 0);
    assert.ok(Date.now() - started < 6500);
  } finally {
    mock.restore();
  }
});
