import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { POST as voice } from "../app/api/webhooks/voice/route";
import { GET as publicAvailability } from "../app/api/availability/route";
import { closeDatabase, listBookings } from "../lib/store";

beforeEach(() => {
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
  const available = await say("2099年12月1日");
  assert.match(available.xml, /可开始时间/);
  assert.match(available.xml, /1号场/);
  assert.match(available.xml, /2号场/);
  await say("一号球场");
  await say("下午三点");
  await say("默认");
  const contact = await say(`我叫${name}`);
  assert.match(contact.xml, /联系电话/);
  const summary = await say("使用来电号码");
  assert.match(summary.xml, new RegExp(name));
  assert.match(summary.xml, /联系电话/);
  assert.match(summary.xml, /2小时/);
  return say;
}

test("spoken booking collects name and confirmed contact, stays on topic, and only writes after explicit confirmation", async () => {
  const say = await pendingBooking();
  assert.equal(listBookings().length, 0);
  const unrelated = await say("给我讲个笑话");
  assert.match(unrelated.xml, /只能帮助/);
  assert.equal(listBookings().length, 0);
  await say("我还没确认");
  assert.equal(listBookings().length, 0);
  const committed = await say("确认预约");
  assert.match(committed.xml, /网站日程已更新/);
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
  assert.match(newSummary.xml, /预约人李四/);
  assert.equal(listBookings().length, 0);
  await corrected("确认预约");
  assert.equal(listBookings()[0].customerName, "李四");
});

test("a last-second conflict offers real alternatives and does not double-book", async () => {
  const first = await pendingBooking("张三");
  const second = await pendingBooking("李四");
  await first("确认预约");
  const conflict = await second("确认预约");
  assert.match(conflict.xml, /已被预约/);
  assert.match(conflict.xml, /可开始时间/);
  assert.equal(listBookings().length, 1);
  await second("下午五点");
  await second("两个小时");
  assert.equal(listBookings().length, 1);
  await second("确认预约");
  assert.equal(listBookings().length, 2);
});

test("half-hour requests and unrelated questions are rejected; an alternative spoken phone is explicitly reviewed", async () => {
  const say = caller();
  await say();
  await say("我要预约");
  await say("2099年12月1日");
  await say("一号球场");
  assert.match((await say("下午三点半")).xml, /整点/);
  assert.match((await say("今天天气怎么样")).xml, /只能帮助/);
  assert.equal(listBookings().length, 0);
  await say("下午三点");
  await say("两个小时");
  await say("我叫王五");
  const summary = await say("我的电话是零四一二三四五六七八");
  assert.match(summary.xml, /0，4，1，2，3，4，5，6，7，8/);
  assert.equal(listBookings().length, 0);
  await say("确认预约");
  assert.equal(listBookings()[0].phone, "0412345678");
});

test("one spoken request can supply intent, date, court and hour without losing those details", async () => {
  const say = caller();
  await say();
  const offered = await say("我要预约2099年12月1日下午三点的二号球场");
  assert.match(offered.xml, /可开始时间/);
  assert.match(offered.xml, /几个小时/);
  await say("默认");
  await say("我叫张三");
  await say("使用来电号码");
  assert.equal(listBookings().length, 0);
  await say("确认预约");
  assert.equal(listBookings()[0].courtId, 2);
  assert.equal(listBookings()[0].startsAt, "2099-12-01T04:00:00Z");
});
