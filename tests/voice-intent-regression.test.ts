import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { POST as voice } from "../app/api/webhooks/voice/route";
import {
  explicitConfirmation,
  parseIntent,
  parseNameSpeech,
} from "../lib/channels/voice-input";
import { closeDatabase, getChannelState, listBookings } from "../lib/store";

const WEBHOOK = "https://courts.example/api/webhooks/voice";

beforeEach(() => {
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.TWILIO_AUTH_TOKEN = "test-only-intent-regression-key";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
});
after(closeDatabase);

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
      "x-twilio-signature": createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
        .update(material)
        .digest("base64"),
    },
    body: new URLSearchParams(fields),
  });
}

function caller() {
  const sid = "CA" + randomUUID().replaceAll("-", "");
  let action = WEBHOOK;
  const send = async (
    speech = "",
    options: { bare?: boolean; digits?: string; turn?: string } = {},
  ) => {
    const url = options.bare
      ? WEBHOOK
      : options.turn !== undefined
        ? `${WEBHOOK}?turn=${encodeURIComponent(options.turn)}`
        : action;
    const fields = {
      CallSid: sid,
      To: process.env.TWILIO_PHONE_NUMBER!,
      From: "+61400123456",
      SpeechResult: speech,
      Digits: options.digits || "",
    };
    const response = await voice(signedRequest(url, fields));
    assert.equal(response.status, 200);
    const xml = await response.text();
    const next = xml.match(/action="([^"]+)"/)?.[1];
    if (next) action = next.replaceAll("&amp;", "&");
    return {
      xml,
      replay: async () => {
        const replayed = await voice(signedRequest(url, fields));
        assert.equal(replayed.status, 200);
        return replayed.text();
      },
    };
  };
  return { send, state: () => JSON.parse(getChannelState(`voice:${sid}`)!) };
}

async function fillBookingToConfirmation() {
  const call = caller();
  await call.send();
  const intent = await call.send("我要预定网球场");
  assert.match(intent.xml, /哪一天/);
  assert.doesNotMatch(intent.xml, /欢迎使用/);
  assert.equal(listBookings().length, 0);
  const availability = await call.send("2099年12月1日");
  assert.match(availability.xml, /可开始时间/);
  await call.send("一号球场");
  await call.send("下午三点");
  await call.send("默认");
  await call.send("我叫张三");
  const summary = await call.send("使用来电号码");
  assert.match(summary.xml, /预约人张三/);
  assert.match(summary.xml, /联系电话/);
  assert.match(summary.xml, /2小时/);
  assert.equal(listBookings().length, 0);
  return call;
}

test("ASR 预定 homophones and traditional forms retain the correct booking intent", () => {
  for (const speech of [
    "我要预定网球场",
    "我想预定网球场",
    "预定",
    "我要預定網球場",
    "我要預訂網球場",
    "我要預約",
    "我要预订",
    "我要预约",
  ]) {
    assert.equal(parseIntent(speech), "book", speech);
  }
  for (const speech of [
    "不要预定网球场",
    "我不想预定",
    "别預定",
    "不要預訂",
    "不预约",
  ]) {
    assert.equal(parseIntent(speech), null, speech);
  }
  for (const speech of ["查看我的预定", "查看我的預定", "查询我的預訂"]) {
    assert.equal(parseIntent(speech), "view", speech);
  }
  assert.equal(parseIntent("修改我的预定"), "change");
  assert.equal(parseIntent("取消我的預定"), "cancel");
  assert.equal(parseIntent("查询目前可以预定的空闲时间"), "query");
  assert.equal(parseNameSpeech("我叫李预定"), "李预定");
});

test("homophone normalization permits explicit confirmation but never turns a negation into confirmation", () => {
  for (const speech of ["确认预定", "確認預定", "确认預訂", "确认預約"]) {
    assert.equal(explicitConfirmation(speech), "confirm", speech);
  }
  for (const speech of [
    "不确认预定",
    "不要确认预定",
    "我不想确认预定",
    "不确认",
    "不要預定",
    "确认预定吗",
    "还没确认预定",
  ]) {
    assert.notEqual(explicitConfirmation(speech), "confirm", speech);
  }
});

test("real caller utterance follows the signed Gather action and completes one booking, with exact retry replay", async () => {
  const call = await fillBookingToConfirmation();
  const committed = await call.send("确认预定");
  assert.match(committed.xml, /网站日程已更新/);
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.phone, "+61400123456");
  assert.equal(booking.courtId, 1);
  assert.equal(booking.durationHours, 2);
  assert.equal(booking.source, "phone");
  assert.equal(await committed.replay(), committed.xml);
  assert.equal(listBookings().length, 1);
});

test("unrecognized menu speech prompts for intent without repeating the welcome introduction", async () => {
  const call = caller();
  assert.match((await call.send()).xml, /欢迎使用/);
  const response = await call.send("我想想");
  assert.doesNotMatch(response.xml, /欢迎使用/);
  assert.match(response.xml, /查询|预订|预约/);
  assert.equal(call.state().step, "menu");
  assert.equal(listBookings().length, 0);
  assert.match((await call.send("我要预定网球场")).xml, /哪一天/);
});

test("an unknown stale or malformed turn gives a spoken read-only recovery instead of a fallback-triggering error", async () => {
  const call = caller();
  await call.send();
  await call.send("我要预定网球场");
  const pending = call.state();
  for (const turn of [randomUUID(), "bad-session-value"]) {
    const recovery = await call.send("2099年12月1日", { turn });
    assert.match(recovery.xml, /哪一天/);
    assert.doesNotMatch(recovery.xml, /欢迎使用/);
    assert.equal(call.state().turn, pending.turn);
    assert.equal(call.state().step, "date");
    assert.equal(listBookings().length, 0);
  }
  assert.match((await call.send("2099年12月1日")).xml, /可开始时间/);
});

test("opt-in callback diagnostics show only routing metadata, never utterances or credentials", async () => {
  const previous = process.env.VOICE_DEBUG;
  const info = console.info;
  const records: string[] = [];
  try {
    process.env.VOICE_DEBUG = "1";
    console.info = (...args: unknown[]) => {
      records.push(args.map(String).join(" "));
    };
    const call = caller();
    await call.send();
    await call.send("我要预定网球场");
    const text = records.join("\n");
    assert.match(text, /"input":"speech"/);
    assert.match(text, /"turn":"present"/);
    assert.ok(!text.includes("我要预定网球场"));
    assert.ok(!text.includes(process.env.TWILIO_AUTH_TOKEN!));
    assert.ok(!text.includes(process.env.TWILIO_PHONE_NUMBER!));
    assert.ok(!text.includes("+61400123456"));
  } finally {
    console.info = info;
    if (previous === undefined) delete process.env.VOICE_DEBUG;
    else process.env.VOICE_DEBUG = previous;
  }
});

test("a speech callback missing its turn recovers the current prompt without consuming input or resetting the flow", async () => {
  const call = caller();
  await call.send();
  await call.send("我要预定网球场");
  assert.equal(call.state().step, "date");
  const recovered = await call.send("2099年12月1日", { bare: true });
  assert.match(recovered.xml, /哪一天/);
  assert.doesNotMatch(recovered.xml, /欢迎使用/);
  assert.equal(call.state().step, "date");
  assert.equal(call.state().action, "book");
  assert.equal(listBookings().length, 0);
  // The requested date was not consumed by an ambiguous callback. The caller
  // can repeat it on the newly issued action URL and continue safely.
  assert.match((await call.send("2099年12月1日")).xml, /可开始时间/);
});

test("missing-turn confirmation cannot mutate a pending booking; a correct new turn confirms exactly once", async () => {
  const call = await fillBookingToConfirmation();
  const before = call.state();
  const recovered = await call.send("确认预定", { bare: true });
  assert.equal(listBookings().length, 0);
  assert.doesNotMatch(recovered.xml, /网站日程已更新|欢迎使用/);
  assert.match(recovered.xml, /预约人张三/);
  const after = call.state();
  for (const field of [
    "step",
    "action",
    "date",
    "court",
    "hour",
    "duration",
    "name",
    "contactPhone",
  ]) {
    assert.equal(after[field], before[field], field);
  }
  assert.equal(after.step, "confirm");
  const confirmed = await call.send("确认预定");
  assert.equal(listBookings().length, 1);
  assert.equal(await confirmed.replay(), confirmed.xml);
  assert.equal(listBookings().length, 1);
});

test("a bare speech callback without an existing session only starts a fresh prompt", async () => {
  const call = caller();
  const initial = await call.send("确认预定", { bare: true });
  assert.match(initial.xml, /请告诉我.*(?:预定|预订).*查询/);
  assert.equal(call.state().step, "menu");
  assert.equal(listBookings().length, 0);
});
