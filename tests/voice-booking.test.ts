import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { POST as voice } from "../app/api/webhooks/voice/route";
import { GET as publicAvailability } from "../app/api/availability/route";
import { closeDatabase, createBooking, listBookings } from "../lib/store";

beforeEach(() => {
  process.env.VOICE_MODE = "gather";
  process.env.TWILIO_ACCOUNT_SID = "";
  process.env.BOOKING_AI_ENABLED = "0";
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.TWILIO_AUTH_TOKEN = "test-only-signature-key";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
});
after(closeDatabase);

function request(url: string, fields: Record<string, string>) {
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
  let url = "https://courts.example/api/webhooks/voice";
  return async (speech = "", digits = "") => {
    const fields = {
      CallSid: sid,
      To: process.env.TWILIO_PHONE_NUMBER!,
      From: "+61400123456",
      SpeechResult: speech,
      Digits: digits,
    };
    const originalUrl = url;
    const response = await voice(request(url, fields));
    assert.equal(response.status, 200);
    const xml = await response.text();
    const next = xml.match(/action="([^"]+)"/)?.[1];
    if (next) url = next.replaceAll("&amp;", "&");
    return { xml, replay: () => voice(request(originalUrl, fields)) };
  };
}
async function pendingBooking(name = "张三") {
  const say = caller();
  await say();
  await say("我要预约");
  const hourQuestion = await say("2099年12月1日");
  assert.match(hourQuestion.xml, /what time.*start/i);
  assert.doesNotMatch(hourQuestion.xml, /choose.*court|which.*court/i);
  await say("下午三点");
  const nameQuestion = await say("默认");
  assert.match(
    nameQuestion.xml,
    /name will appear publicly on the website schedule/i,
  );
  const contact = await say(`我叫${name}`);
  assert.match(contact.xml, /contact number/i);
  const summary = await say("使用来电号码");
  assert.match(summary.xml, new RegExp(name));
  assert.match(summary.xml, /contact number/i);
  assert.match(summary.xml, /2 hours/);
  assert.match(summary.xml, /contact number: the number you are calling from/i);
  assert.doesNotMatch(
    summary.xml,
    /61400123456|six one four zero|name will appear publicly|15:00|2099-/i,
  );
  return say;
}

test("spoken booking collects name and confirmed contact, stays on topic, and only writes after explicit confirmation", async () => {
  const say = await pendingBooking();
  assert.equal(listBookings().length, 0);
  const unrelated = await say("给我讲个笑话");
  assert.match(
    unrelated.xml,
    /only help check, create, change or cancel tennis court bookings/i,
  );
  assert.equal(listBookings().length, 0);
  await say("我还没确认");
  assert.equal(listBookings().length, 0);
  const committed = await say("确认预约");
  assert.match(committed.xml, /Booking confirmed/i);
  assert.match(committed.xml, /SMS is unavailable/i);
  assert.equal([...committed.xml.matchAll(/booking reference:/g)].length, 1);
  assert.equal([...committed.xml.matchAll(/Access code:/g)].length, 1);
  assert.doesNotMatch(
    committed.xml,
    /read.*again|website schedule has been updated/i,
  );
  assert.equal(listBookings().length, 1);
  const booking = listBookings()[0];
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.phone, "+61400123456");
  assert.equal(booking.source, "phone");
  assert.equal(booking.durationHours, 2);
  assert.equal(booking.courtId, 1);
  assert.equal(await (await committed.replay()).text(), committed.xml);
  assert.equal(listBookings().length, 1);
  const response = publicAvailability(
    new Request("https://courts.example/api/availability?date=2099-12-01"),
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.courts[0].bookings[0].customerName, "张三");
  assert.equal(
    data.slots.find(
      (slot: { courtId: number; startLocal: string }) =>
        slot.courtId === 1 && slot.startLocal.endsWith("T15:00"),
    ).available,
    false,
  );
  assert.ok(!JSON.stringify(data).includes(booking.phone));
});

test("rejecting a booking or correcting its name never writes the earlier summary", async () => {
  const rejected = await pendingBooking();
  await rejected("不确认");
  assert.equal(listBookings().length, 0);
  const ended = await rejected("不预订了");
  assert.match(ended.xml, /<Hangup\/>/);
  const corrected = await pendingBooking();
  await corrected("修改姓名");
  const newSummary = await corrected("我叫李四");
  assert.match(newSummary.xml, /Booking name: 李四/i);
  assert.equal(listBookings().length, 0);
  await corrected("确认预约");
  assert.equal(listBookings()[0].customerName, "李四");
});

test("a last-second conflict reviews the other available court and requires another confirmation", async () => {
  const first = await pendingBooking("张三");
  const second = await pendingBooking("李四");
  await first("确认预约");
  const conflict = await second("确认预约");
  assert.match(conflict.xml, /just booked/i);
  assert.match(conflict.xml, /Court 2/);
  assert.match(conflict.xml, /confirm booking/i);
  assert.equal(listBookings().length, 1);
  await second("确认预约");
  assert.equal(listBookings().length, 2);
  assert.equal(
    listBookings().find((booking) => booking.customerName === "李四")?.courtId,
    2,
  );
  assert.equal(
    listBookings().find((booking) => booking.customerName === "李四")?.startsAt,
    "2099-12-01T04:00:00Z",
  );
});

test("automatic assignment checks the full requested interval before selecting court two", async () => {
  createBooking({
    courtId: 1,
    startLocal: "2099-12-01T16:00",
    durationHours: 1,
    customerName: "其他预约人",
    phone: "+61400999999",
    source: "web",
  });
  const say = await pendingBooking();
  const committed = await say("确认预约");
  assert.match(committed.xml, /Booking confirmed/i);
  const assigned = listBookings().find(
    (booking) => booking.customerName === "张三",
  );
  assert.equal(assigned?.courtId, 2);
  assert.equal(assigned?.startsAt, "2099-12-01T04:00:00Z");
  assert.equal(assigned?.endsAt, "2099-12-01T06:00:00Z");
  assert.equal(assigned?.durationHours, 2);
  assert.equal(await (await committed.replay()).text(), committed.xml);
  assert.equal(listBookings().length, 2);
});

test("half-hour requests and unrelated questions are rejected; an alternative spoken phone is explicitly reviewed", async () => {
  const say = caller();
  await say();
  await say("我要预约");
  await say("2099年12月1日");
  assert.match((await say("下午三点半")).xml, /whole hour|on the hour/i);
  assert.match(
    (await say("今天天气怎么样")).xml,
    /only help check, create, change or cancel tennis court bookings/i,
  );
  assert.equal(listBookings().length, 0);
  await say("下午三点");
  await say("两个小时");
  await say("我叫王五");
  const summary = await say("我的电话是零四一二三四五六七八");
  assert.match(
    summary.xml,
    /zero four one two, three four five six, seven eight/,
  );
  assert.equal(listBookings().length, 0);
  await say("确认预约");
  assert.equal(listBookings()[0].phone, "0412345678");
});

test("one spoken request retains intent, date and hour while the server assigns the first available court", async () => {
  const say = caller();
  await say();
  const offered = await say("我要预约2099年12月1日下午三点的二号球场");
  assert.match(offered.xml, /how many hours/i);
  assert.doesNotMatch(offered.xml, /choose.*court|which.*court/i);
  await say("默认");
  await say("我叫张三");
  await say("使用来电号码");
  assert.equal(listBookings().length, 0);
  await say("确认预约");
  assert.equal(listBookings()[0].courtId, 1);
  assert.equal(listBookings()[0].startsAt, "2099-12-01T04:00:00Z");
});

test("spoken availability reports real open starts in natural hours without disclosing other bookings", async () => {
  createBooking({
    courtId: 1,
    startLocal: "2099-12-01T15:00",
    durationHours: 2,
    customerName: "其他预约人",
    phone: "+61400999999",
    source: "web",
  });
  const say = caller();
  await say();
  await say("查空档");
  await say("2099年12月1日");
  const reply = await say("默认");
  assert.match(reply.xml, /Court 1: midnight to 1 pm, 5 to 11 pm/);
  assert.match(reply.xml, /Court 2: midnight to 11 pm/);
  assert.doesNotMatch(reply.xml, /其他预约人|999999|\d{2}:00|2099-/);
  assert.equal(listBookings().length, 1);
});
