import { beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { closeDatabase, getBooking, listBookings } from "../lib/store";
import { POST as sms } from "../app/api/webhooks/sms/route";
import { POST as voice } from "../app/api/webhooks/voice/route";
import { authenticateEmail, prepareEmail } from "../lib/channels/email";
import { COMMAND_HELP } from "../lib/channels/commands";

beforeEach(() => {
  process.env.BOOKING_AI_ENABLED = "0";
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.TWILIO_AUTH_TOKEN = "test-signing-key-not-a-real-credential";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
  process.env.POSTMARK_INBOUND_SECRET =
    "test-inbound-secret-not-a-real-credential";
  process.env.POSTMARK_SERVER_TOKEN =
    "test-outbound-token-not-a-real-credential";
  process.env.POSTMARK_FROM_EMAIL = "courts@example.com";
  process.env.POSTMARK_INBOUND_EMAIL = "bookings@inbound.example.com";
});
after(closeDatabase);

function signedRequest(
  url: string,
  fields: Record<string, string>,
  valid = true,
) {
  const sorted = Object.keys(fields)
    .sort()
    .map((key) => key + fields[key])
    .join("");
  const signature = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
    .update(url + sorted)
    .digest("base64");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": valid ? signature : "invalid",
    },
    body: new URLSearchParams(fields),
  });
}
const common = () => ({
  To: process.env.TWILIO_PHONE_NUMBER!,
  From: "+61400123456",
});
const smsFields = (
  Body: string,
  MessageSid = "SM" + randomUUID().replaceAll("-", ""),
) => ({ ...common(), Body, MessageSid });

test("SMS rejects invalid signatures and missing channel configuration", async () => {
  const response = await sms(
    signedRequest(
      "https://courts.example/api/webhooks/sms",
      smsFields("HELP"),
      false,
    ),
  );
  assert.equal(response.status, 403);
  delete process.env.TWILIO_AUTH_TOKEN;
  assert.equal(
    (
      await sms(
        new Request("https://courts.example/api/webhooks/sms", {
          method: "POST",
        }),
      )
    ).status,
    503,
  );
});

test("signed SMS creates, replays once, modifies and cancels one persisted booking", async () => {
  const url = "https://courts.example/api/webhooks/sms";
  const fields = smsFields("预订 1 2099-12-01 23:00 张三");
  const first = await (await sms(signedRequest(url, fields))).text();
  const duplicate = await (await sms(signedRequest(url, fields))).text();
  assert.equal(first, duplicate);
  assert.equal(listBookings().length, 1);
  const id = first.match(/预约(\d{8})/)?.[1];
  const code = first.match(/管理码：(\d{10})/)?.[1];
  assert.ok(id && code);
  const booking = getBooking(id, code);
  assert.equal(booking.source, "sms");
  assert.equal(booking.durationHours, 2);
  assert.equal(booking.customerName, "张三");
  const availability = await (
    await sms(signedRequest(url, smsFields("查询 2099-12-01 1 2")))
  ).text();
  assert.match(availability, /可开始时间/);
  assert.match(availability, /1号场/);
  assert.doesNotMatch(availability, /2号场/);
  const viewed = await (
    await sms(signedRequest(url, smsFields(`查看 ${id} ${code}`)))
  ).text();
  assert.match(viewed, new RegExp(id));
  const change = smsFields(`修改 ${id} ${code} 2 2099-12-02 12:00 3`);
  const changed = await (await sms(signedRequest(url, change))).text();
  assert.match(changed, /2号场/);
  assert.equal(await (await sms(signedRequest(url, change))).text(), changed);
  assert.equal(getBooking(id, code).version, 2);
  const cancellation = await (
    await sms(signedRequest(url, smsFields(`取消 ${id} ${code}`)))
  ).text();
  assert.match(cancellation, /已取消/);
  assert.equal(getBooking(id, code).status, "cancelled");
});

test("SMS conflict and invalid management code cannot alter an existing booking", async () => {
  const url = "https://courts.example/api/webhooks/sms";
  await sms(signedRequest(url, smsFields("BOOK 1 2099-12-01 10:00 Alice")));
  const conflict = await (
    await sms(signedRequest(url, smsFields("BOOK 1 2099-12-01 11:00 Bob")))
  ).text();
  assert.match(conflict, /已被预约/);
  const failed = await (
    await sms(
      signedRequest(url, smsFields(`取消 ${listBookings()[0].id} 0000000000`)),
    )
  ).text();
  assert.match(failed, /不正确/);
  assert.equal(
    listBookings().filter((item) => item.status === "confirmed").length,
    1,
  );
});

test("Postmark authentication and command replay; no outbound network is invoked", () => {
  assert.throws(
    () =>
      authenticateEmail(
        new Request("https://courts.example/api/webhooks/email"),
      ),
    /认证/,
  );
  const authorization = `Basic ${Buffer.from(`postmark:${process.env.POSTMARK_INBOUND_SECRET}`).toString("base64")}`;
  authenticateEmail(
    new Request("https://courts.example/api/webhooks/email", {
      headers: { authorization },
    }),
  );
  const payload = {
    MessageID: randomUUID(),
    FromFull: { Email: "alice@example.com" },
    Subject: "BOOK 2 2099-12-01 12:00 Alice",
  };
  const first = prepareEmail(payload);
  const again = prepareEmail(payload);
  assert.deepEqual(first, again);
  assert.equal(listBookings().length, 1);
  assert.equal(listBookings()[0].source, "email");
  assert.equal(first.reply?.to, "alice@example.com");
  assert.match(first.reply!.text, /管理码/);
  const id = first.reply!.text.match(/预约(\d{8})/)![1];
  const code = first.reply!.text.match(/管理码：(\d{10})/)![1];
  const command = (Subject: string) =>
    prepareEmail({ ...payload, MessageID: randomUUID(), Subject }).reply!.text;
  assert.match(command("查询 2099-12-01"), /可开始时间/);
  assert.match(command(`查看 ${id} ${code}`), new RegExp(id));
  assert.match(command(`修改 ${id} ${code} 1 2099-12-02 15:00`), /1号场/);
  assert.equal(getBooking(id, code).version, 2);
  assert.match(command(`取消 ${id} ${code}`), /已取消/);
  assert.equal(getBooking(id, code).status, "cancelled");
  const ignored = prepareEmail({
    ...payload,
    MessageID: randomUUID(),
    Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }],
  });
  assert.equal(ignored.reply, null);
  assert.equal(
    prepareEmail({ ...payload, MessageID: randomUUID(), Subject: "帮助" }).reply
      ?.text,
    COMMAND_HELP,
  );
});

test("guided phone query, booking, view, modification and cancellation use short confirmation steps", async () => {
  const callSid = "CA" + randomUUID().replaceAll("-", "");
  let url = "https://courts.example/api/webhooks/voice";
  const send = async (Digits = "", SpeechResult = "") => {
    const fields = { ...common(), CallSid: callSid, Digits, SpeechResult };
    const requestUrl = url;
    const xml = await (await voice(signedRequest(requestUrl, fields))).text();
    const action = xml.match(/action="([^"]+)"/)?.[1];
    assert.ok(action, xml);
    url = action.replaceAll("&amp;", "&");
    return { xml, requestUrl, fields };
  };
  assert.match((await send()).xml, /欢迎使用/);
  await send("1");
  await send("20991201");
  await send("0");
  assert.match((await send("2")).xml, /可开始时间/);
  assert.match((await send("2")).xml, /八位日期/);
  await send("20991201");
  await send("1");
  await send("23");
  await send("2");
  const contact = await send("", "李四");
  assert.match(contact.xml, /联系电话/);
  assert.equal(listBookings().length, 0);
  const confirmation = await send("1");
  assert.match(confirmation.xml, /姓名将公开展示/);
  assert.equal(listBookings().length, 0);
  const committed = await send("1");
  assert.equal(listBookings().length, 1);
  const duplicate = await (
    await voice(signedRequest(committed.requestUrl, committed.fields))
  ).text();
  assert.equal(duplicate, committed.xml);
  const id = listBookings()[0].id;
  const rawCode = committed.xml
    .match(/管理码：([^。]+)/)?.[1]
    .replaceAll("，", "");
  assert.match(rawCode!, /^\d{10}$/);
  assert.equal(listBookings()[0].source, "phone");
  assert.equal(listBookings()[0].customerName, "李四");
  await send("5");
  await send(id);
  assert.match((await send(rawCode!)).xml, new RegExp(id));
  await send("3");
  await send(id);
  await send(rawCode!);
  await send("20991202");
  await send("2");
  await send("12");
  assert.match((await send("3")).xml, /即将修改预约/);
  assert.equal(listBookings()[0].version, 1);
  await send("1");
  assert.equal(listBookings()[0].version, 2);
  assert.equal(listBookings()[0].courtId, 2);
  assert.equal(listBookings()[0].durationHours, 3);
  await send("4");
  await send(id);
  const cancelPrompt = await send(rawCode!);
  assert.match(cancelPrompt.xml, /确认取消/);
  assert.equal(listBookings()[0].status, "confirmed");
  await send("1");
  assert.equal(listBookings()[0].status, "cancelled");
});
