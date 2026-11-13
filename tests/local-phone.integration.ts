import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import type { Availability, Booking } from "../lib/domain";
import { createVoiceRelay } from "../scripts/voice-relay.mjs";
import { spokenCredential } from "./spoken-credential";

// Only local sockets are used. These stand-ins never contact Twilio or ngrok.
const publicOrigin = "https://local-phone.example";
const signingToken = "local-phone-test-key-not-a-real-credential";
const receivingNumber = "+61255550100";
const callingNumber = "+61400123456";
const date = "2099-12-01";
let directory: string | undefined;
let app: ChildProcess | undefined;
let appStopped: Promise<void> | undefined;
let appSpawnFailed = false;
let relay: Server | undefined;
let appUrl: string;
let relayUrl: string;

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function stopApp(signal: NodeJS.Signals) {
  if (!app?.pid) return;
  try {
    if (process.platform === "win32") app.kill(signal);
    else process.kill(-app.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

before(
  async () => {
    directory = await mkdtemp(join(tmpdir(), "courtside-local-phone-"));
    const port = await freePort();
    appUrl = `http://127.0.0.1:${port}`;
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (
        ["TWILIO_", "POSTMARK_", "NGROK_"].some((prefix) =>
          name.startsWith(prefix),
        )
      )
        environment[name] = "";
    }
    Object.assign(environment, {
      BOOKING_AI_ENABLED: "0",
      VOICE_MODE: "gather",
      REALTIME_BRIDGE_SECRET: "",
      OPENAI_API_KEY: "",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      BOOKING_DB_PATH: join(directory, "bookings.sqlite"),
      ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
      APP_BASE_URL: publicOrigin,
      RENDER_EXTERNAL_URL: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: signingToken,
      TWILIO_PHONE_NUMBER: receivingNumber,
      POSTMARK_INBOUND_SECRET: "",
      POSTMARK_SERVER_TOKEN: "",
      POSTMARK_FROM_EMAIL: "",
      POSTMARK_INBOUND_EMAIL: "",
      NGROK_AUTHTOKEN: "",
      NGROK_DOMAIN: "",
    });
    app = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "next", "dist", "bin", "next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: environment,
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    appStopped = new Promise<void>((resolve) => {
      app!.once("exit", () => resolve());
      app!.once("error", () => {
        appSpawnFailed = true;
        resolve();
      });
    });
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (appSpawnFailed || app.exitCode !== null || app.signalCode !== null)
        throw new Error(
          "Local phone test application failed to start; build the project first.",
        );
      try {
        const response = await fetch(`${appUrl}/api/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        const body = (await response.json()) as { status?: string };
        if (response.ok && body.status === "ok") {
          ready = true;
          break;
        }
      } catch {
        /* bounded polling while the production process starts */
      }
      await delay(100);
    }
    assert.ok(ready, "production application must become ready");
    relay = createVoiceRelay({ upstreamPort: port, allowSms: true });
    await new Promise<void>((resolve, reject) => {
      relay!.once("error", reject);
      relay!.listen(0, "127.0.0.1", resolve);
    });
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    relayUrl = `http://127.0.0.1:${address.port}`;
  },
  { timeout: 40_000 },
);

after(
  async () => {
    try {
      if (relay) {
        relay.closeAllConnections();
        if (relay.listening)
          await new Promise<void>((resolve, reject) =>
            relay!.close((error) => (error ? reject(error) : resolve())),
          );
      }
    } finally {
      try {
        if (
          app &&
          appStopped &&
          app.exitCode === null &&
          app.signalCode === null &&
          !appSpawnFailed
        ) {
          stopApp("SIGTERM");
          await Promise.race([
            appStopped,
            delay(3_000, undefined, { ref: false }),
          ]);
          if (app.exitCode === null && app.signalCode === null) {
            stopApp("SIGKILL");
            await Promise.race([
              appStopped,
              delay(2_000, undefined, { ref: false }),
            ]);
          }
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  },
  { timeout: 10_000 },
);

type Turn = { path: string; fields: Record<string, string> };

async function signedTurn(turn: Turn, validSignature = true) {
  const material =
    publicOrigin +
    turn.path +
    Object.keys(turn.fields)
      .sort()
      .map((key) => key + turn.fields[key])
      .join("");
  const signature = createHmac("sha1", signingToken)
    .update(material)
    .digest("base64");
  const response = await fetch(relayUrl + turn.path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      "x-twilio-signature": validSignature
        ? signature
        : "invalid-local-test-signature",
    },
    body: new URLSearchParams(turn.fields).toString(),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, text: await response.text() };
}

async function publicSchedule(dateValue = date): Promise<Availability> {
  const response = await fetch(`${appUrl}/api/availability?date=${dateValue}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<Availability>;
}

test("the opt-in SMS relay hides website, staff and email routes and all real handlers reject forged signatures", async () => {
  for (const path of [
    "/",
    "/admin",
    "/api/bookings",
    "/api/admin/session",
    "/api/admin/bookings/123/attendance-call",
  ]) {
    const response = await fetch(relayUrl + path, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(
      response.status,
      404,
      "website and staff endpoints must not cross the phone relay",
    );
  }
  const forged = await signedTurn(
    {
      path: "/api/webhooks/voice",
      fields: {
        CallSid: "CA" + randomUUID().replaceAll("-", ""),
        From: callingNumber,
        To: receivingNumber,
      },
    },
    false,
  );
  assert.equal(forged.response.status, 403);
  assert.equal(forged.response.headers.get("set-cookie"), null);
  const forgedSms = await signedTurn(
    {
      path: "/api/webhooks/sms",
      fields: {
        MessageSid: "SM" + randomUUID().replaceAll("-", ""),
        From: callingNumber,
        To: receivingNumber,
        Body: "预订 2 2099-12-01 23:00 李四",
      },
    },
    false,
  );
  assert.equal(forgedSms.response.status, 403);
  assert.equal(forgedSms.response.headers.get("set-cookie"), null);
  const forgedAttendance = await signedTurn(
    {
      path: "/api/webhooks/attendance?attempt=local-forged-test&turn=initial",
      fields: {
        CallSid: "CA" + randomUUID().replaceAll("-", ""),
        From: receivingNumber,
        To: callingNumber,
        Direction: "outbound-api",
      },
    },
    false,
  );
  assert.equal(forgedAttendance.response.status, 403);
  assert.equal(forgedAttendance.response.headers.get("set-cookie"), null);
  const email = await fetch(`${relayUrl}/api/webhooks/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic dGVzdDp0ZXN0",
    },
    body: JSON.stringify({ MessageID: randomUUID() }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(
    email.status,
    404,
    "enabling SMS must not expose email callbacks",
  );
  const schedule = await publicSchedule();
  assert.equal(schedule.courts.flatMap((court) => court.bookings).length, 0);
});

test("signed speech crosses the real relay and production app, requires confirmation and persists exactly one private-contact booking", async () => {
  const callSid = "CA" + randomUUID().replaceAll("-", "");
  let path = "/api/webhooks/voice";
  const speak = async (speech = "") => {
    const turn: Turn = {
      path,
      fields: {
        CallSid: callSid,
        From: callingNumber,
        To: receivingNumber,
        CallStatus: "in-progress",
        Digits: "",
        SpeechResult: speech,
      },
    };
    const result = await signedTurn(turn);
    assert.equal(
      result.response.status,
      200,
      "a locally signed speech turn must reach the production handler",
    );
    assert.match(
      result.response.headers.get("content-type") || "",
      /text\/xml/,
    );
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("set-cookie"), null);
    const action = result.text.match(/<Gather\b[^>]*action="([^"]+)"/)?.[1];
    assert.ok(
      action,
      "the speech response must contain a next-step Gather callback",
    );
    const callback = new URL(action.replaceAll("&amp;", "&"));
    assert.equal(
      callback.origin,
      publicOrigin,
      "callbacks use the configured HTTPS origin rather than the private upstream address",
    );
    assert.equal(callback.pathname, "/api/webhooks/voice");
    assert.match(callback.searchParams.get("turn") || "", /^[a-f0-9-]{36}$/);
    path = callback.pathname + callback.search;
    return { ...result, turn };
  };
  assert.match((await speak()).text, /您好，想预约球场还是查空档/);
  const requested = await speak("我要预定网球场");
  assert.match(requested.text, /哪一天/);
  assert.doesNotMatch(requested.text, /您好，想预约球场还是查空档/);
  const timeQuestion = await speak("2099年12月1日");
  assert.match(timeQuestion.text, /几点开始/);
  assert.doesNotMatch(timeQuestion.text, /想订一号场|选择.*球场/);
  assert.match((await speak("下午三点")).text, /几个小时/);
  const nameQuestion = await speak("默认");
  assert.match(nameQuestion.text, /预约人叫什么名字/);
  assert.match(nameQuestion.text, /姓名会公开显示/);
  assert.match((await speak("我叫张三")).text, /联系电话/);
  const confirm = await speak("使用来电号码");
  assert.match(confirm.text, /确认请说确认预约/);
  assert.match(confirm.text, /1号场/);
  assert.doesNotMatch(confirm.text, /姓名会公开显示/);
  assert.equal(
    (await publicSchedule()).courts.flatMap((court) => court.bookings).length,
    0,
    "gathering details must not reserve a court before explicit confirmation",
  );

  const committed = await speak("确认预定");
  assert.match(committed.text, /预约成功/);
  const schedule = await publicSchedule();
  const bookings = schedule.courts.flatMap((court) => court.bookings);
  assert.equal(bookings.length, 1);
  const booking = bookings[0];
  assert.equal(booking.customerName, "张三");
  assert.equal(booking.courtId, 1);
  assert.equal(
    Date.parse(booking.endsAt) - Date.parse(booking.startsAt),
    7_200_000,
  );
  const serialized = JSON.stringify(schedule);
  assert.ok(
    !serialized.includes(callingNumber),
    "public web schedules omit telephone contact details",
  );
  assert.ok(
    !serialized.includes("phone") &&
      !serialized.includes("email") &&
      !serialized.includes("accessCode"),
  );

  const replay = await signedTurn(committed.turn);
  assert.equal(replay.response.status, 200);
  assert.equal(
    replay.text,
    committed.text,
    "provider retries replay the same response including its opaque next-turn URL",
  );
  assert.equal(
    (await publicSchedule()).courts.flatMap((court) => court.bookings).length,
    1,
    "replaying the confirmation must not duplicate a booking",
  );

  const accessCode = spokenCredential(committed.text);
  assert.ok(
    accessCode && /^\d{10}$/.test(accessCode),
    "the caller receives a private spoken management code",
  );
  assert.ok(
    !serialized.includes(accessCode),
    "the management code never appears in the public schedule",
  );
  const lookup = await fetch(`${appUrl}/api/bookings/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl },
    body: JSON.stringify({ id: booking.id, accessCode }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(lookup.status, 200);
  const privateBooking = ((await lookup.json()) as { booking: Booking })
    .booking;
  assert.equal(privateBooking.source, "phone");
  assert.equal(privateBooking.phone, callingNumber);
  assert.equal(privateBooking.durationHours, 2);
  assert.equal(privateBooking.customerName, "张三");
});

test("signed SMS crosses the opt-in relay and shared production database for query, booking, modification and cancellation", async () => {
  const sms = async (
    body: string,
    messageSid = "SM" + randomUUID().replaceAll("-", ""),
  ) => {
    const turn: Turn = {
      path: "/api/webhooks/sms",
      fields: {
        MessageSid: messageSid,
        From: callingNumber,
        To: receivingNumber,
        Body: body,
      },
    };
    const result = await signedTurn(turn);
    assert.equal(result.response.status, 200);
    assert.match(
      result.response.headers.get("content-type") || "",
      /text\/xml/,
    );
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("set-cookie"), null);
    assert.match(result.text, /<Message>[\s\S]+<\/Message>/);
    return { ...result, turn };
  };
  const query = await sms("查询 2099-12-01 2 2");
  assert.match(query.text, /可开始时间/);
  assert.match(query.text, /2号场/);
  assert.doesNotMatch(query.text, /1号场/);
  const initialCount = (await publicSchedule()).courts.flatMap(
    (court) => court.bookings,
  ).length;
  const created = await sms("预订 2 2099-12-01 23:00 李四");
  const id = created.text.match(/预约(\d{8})/)?.[1];
  const accessCode = created.text.match(/管理码：(\d{10})/)?.[1];
  assert.ok(
    id && accessCode,
    "the SMS sender receives a reference and private management code",
  );
  const schedule = await publicSchedule();
  const bookings = schedule.courts.flatMap((court) => court.bookings);
  assert.equal(bookings.length, initialCount + 1);
  const booking = bookings.find((entry) => entry.id === id);
  assert.ok(
    booking,
    "an SMS booking appears in the same schedule used by the website",
  );
  assert.equal(booking.customerName, "李四");
  assert.equal(booking.courtId, 2);
  assert.equal(
    Date.parse(booking.endsAt) - Date.parse(booking.startsAt),
    7_200_000,
  );
  const tomorrow = await publicSchedule("2099-12-02");
  assert.ok(
    tomorrow.courts[1].bookings.some((entry) => entry.id === id),
    "a two-hour 23:00 booking remains occupied across midnight",
  );
  for (const publicData of [schedule, tomorrow]) {
    const serialized = JSON.stringify(publicData);
    assert.ok(!serialized.includes(callingNumber));
    assert.ok(!serialized.includes(accessCode));
    assert.ok(
      !serialized.includes('"phone"') &&
        !serialized.includes('"email"') &&
        !serialized.includes('"accessCode"'),
    );
  }
  const replay = await signedTurn(created.turn);
  assert.equal(replay.response.status, 200);
  assert.equal(
    replay.text,
    created.text,
    "duplicate MessageSid replays the same private reply",
  );
  assert.equal(
    (await publicSchedule()).courts.flatMap((court) => court.bookings).length,
    initialCount + 1,
  );

  const lookup = async () => {
    const response = await fetch(`${appUrl}/api/bookings/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ id, accessCode }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { booking: Booking }).booking;
  };
  const privateBooking = await lookup();
  assert.equal(privateBooking.source, "sms");
  assert.equal(privateBooking.phone, callingNumber);
  assert.equal(privateBooking.customerName, "李四");
  assert.equal(privateBooking.durationHours, 2);
  assert.equal(privateBooking.version, 1);

  const conflict = await sms("预订 2 2099-12-02 00:00 王五");
  assert.match(conflict.text, /已被预约/);
  assert.equal(
    (await publicSchedule("2099-12-02")).courts[1].bookings.filter(
      (entry) => entry.id === id,
    ).length,
    1,
  );
  assert.equal((await lookup()).version, 1);
  const viewed = await sms(`查看 ${id} ${accessCode}`);
  assert.match(viewed.text, new RegExp(`预约${id}`));
  assert.match(viewed.text, /已确认/);
  const edited = await sms(`修改 ${id} ${accessCode} 1 2099-12-02 12:00 3`);
  assert.match(edited.text, /1号场/);
  assert.match(edited.text, /3小时/);
  const editReplay = await signedTurn(edited.turn);
  assert.equal(editReplay.response.status, 200);
  assert.equal(editReplay.text, edited.text);
  const updated = await lookup();
  assert.equal(
    updated.version,
    2,
    "a duplicate modification must not increment the version again",
  );
  assert.equal(updated.courtId, 1);
  assert.equal(updated.durationHours, 3);
  assert.equal(updated.customerName, "李四");
  assert.equal(updated.phone, callingNumber);
  assert.equal(
    (await publicSchedule()).courts
      .flatMap((court) => court.bookings)
      .some((entry) => entry.id === id),
    false,
  );
  const editedPublic = await publicSchedule("2099-12-02");
  assert.ok(editedPublic.courts[0].bookings.some((entry) => entry.id === id));
  assert.equal(
    editedPublic.courts[1].bookings.some((entry) => entry.id === id),
    false,
  );

  const cancelled = await sms(`取消 ${id} ${accessCode}`);
  assert.match(cancelled.text, /已取消/);
  const cancelReplay = await signedTurn(cancelled.turn);
  assert.equal(cancelReplay.response.status, 200);
  assert.equal(cancelReplay.text, cancelled.text);
  assert.equal((await lookup()).status, "cancelled");
  assert.equal((await lookup()).version, 3);
  const afterCancellation = await publicSchedule("2099-12-02");
  assert.equal(
    afterCancellation.courts
      .flatMap((court) => court.bookings)
      .some((entry) => entry.id === id),
    false,
  );
  assert.equal(
    afterCancellation.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T12:00"),
    )?.available,
    true,
  );
});
