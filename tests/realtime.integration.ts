import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import type { Availability, Booking } from "../lib/domain";
import { createRealtimeBridge } from "../scripts/realtime-bridge.mjs";
import { createVoiceRelay } from "../scripts/voice-relay.mjs";
import { spokenCredential } from "./spoken-credential";

// Every network connection stays on loopback. The provider emits scripted
// transcription/tool/audio events; this does not test speech recognition.
const publicOrigin = "https://realtime-integration.example";
const signingToken = "realtime-integration-fake-twilio-token";
const bridgeSecret = "realtime-integration-fake-server-only-secret";
const apiKey = "realtime-integration-fake-openai-key";
const callingNumber = "+61400123456";
const receivingNumber = "+61255550100";
const streamPath = "/api/realtime/voice";
const bookingDate = "2099-12-01";
const silence = Buffer.alloc(160, 0xff).toString("base64");
const fields = {
  scope: "booking",
  action: "book",
  date: bookingDate,
  court: 2,
  hour: "15",
  duration: 2,
  name: "张三",
  correction: null,
};

type Message = Record<string, unknown>;
type Call = { callSid: string; streamSid: string; ticket: string; xml: string };
let directory: string | undefined;
let app: ChildProcess | undefined;
let appStopped: Promise<void> | undefined;
let appSpawnFailed = false;
let appOutput = "";
let appUrl: string;
let relayUrl: string;
let relay: Server | undefined;
let providerServer: Server | undefined;
let providerSockets: WebSocketServer | undefined;
let bridge: ReturnType<typeof createRealtimeBridge> | undefined;
let providerConnects = 0;
const clients = new Set<WebSocket>();

function object(value: unknown): Message {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Message;
}

class Inbox<T> {
  readonly values: T[] = [];
  private readonly events = new EventEmitter();

  push(value: T) {
    this.values.push(value);
    this.events.emit("value");
  }

  wait(
    predicate: (value: T) => boolean,
    description: string,
    after = 0,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const match = this.values.slice(after).find(predicate);
        if (match === undefined) return;
        clearTimeout(timer);
        this.events.off("value", check);
        resolve(match);
      };
      const timer = setTimeout(() => {
        this.events.off("value", check);
        reject(new Error(`Timed out waiting for ${description}`));
      }, 5_000);
      this.events.on("value", check);
      check();
    });
  }
}

class FakeProvider {
  readonly messages = new Inbox<Message>();
  readonly prompts = new Inbox<string>();
  toolResponses = 0;
  omitFunctionCalls = false;
  private sequence = 0;

  constructor(readonly socket: WebSocket) {
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      const message = object(JSON.parse(raw.toString()));
      this.messages.push(message);
      if (message.type === "session.update") {
        this.send({ type: "session.updated", session: message.session });
      } else if (message.type === "response.create") {
        const request = object(message.response);
        const id = `resp_integration_${++this.sequence}`;
        this.send({
          type: "response.created",
          response: { ...request, id, status: "in_progress", output: [] },
        });
        let output: Message[] = [];
        if (request.tool_choice === "none") {
          assert.deepEqual(request.output_modalities, ["audio"]);
          const instructions = String(request.instructions);
          const prompt = JSON.parse(
            instructions.slice(instructions.lastIndexOf("\n") + 1),
          );
          assert.equal(typeof prompt, "string");
          this.prompts.push(prompt);
          this.send({
            type: "response.output_audio.delta",
            response_id: id,
            item_id: `item_audio_${this.sequence}`,
            delta: silence,
          });
        } else {
          assert.deepEqual(request.output_modalities, ["text"]);
          assert.deepEqual(request.tool_choice, {
            type: "function",
            name: "booking_turn",
          });
          this.toolResponses += 1;
          if (!this.omitFunctionCalls)
            output = [
              {
                type: "function_call",
                name: "booking_turn",
                call_id: `call_integration_${this.sequence}`,
                arguments: JSON.stringify(fields),
              },
            ];
        }
        this.send({
          type: "response.done",
          response: { ...request, id, status: "completed", output },
        });
      }
    });
  }

  send(message: Message) {
    this.socket.send(JSON.stringify(message));
  }

  transcript(itemId: string, transcript: string) {
    this.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript,
    });
  }
}

const providers = new Inbox<FakeProvider>();

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  return address.port;
}

async function closeServer(server?: Server) {
  if (!server) return;
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function closed(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket did not close")),
      3_000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    directory = await mkdtemp(
      join(tmpdir(), "courtside-realtime-integration-"),
    );
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    appUrl = `http://127.0.0.1:${port}`;
    // Copy only runtime settings: never read inherited provider credentials.
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "TZ",
    ])
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    Object.assign(environment, {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      BOOKING_DB_PATH: join(directory, "bookings.sqlite"),
      ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
      APP_BASE_URL: publicOrigin,
      RENDER_EXTERNAL_URL: "",
      BOOKING_AI_ENABLED: "0",
      VOICE_MODE: "realtime",
      VOICE_DEBUG: "0",
      REALTIME_BRIDGE_SECRET: bridgeSecret,
      OPENAI_API_KEY: apiKey,
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
        stdio: ["ignore", "pipe", "pipe"],
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
    for (const output of [app.stdout, app.stderr])
      output?.on("data", (chunk: Buffer) => {
        appOutput = (appOutput + chunk.toString("utf8")).slice(-8_192);
      });
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (appSpawnFailed || app.exitCode !== null || app.signalCode !== null)
        throw new Error(
          `Realtime production fixture failed; build first. ${appOutput}`,
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
        // The production HTTP process is still starting; polling is bounded.
      }
      await delay(100);
    }
    assert.ok(ready, `Production app did not become ready. ${appOutput}`);
    providerServer = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    providerSockets = new WebSocketServer({ server: providerServer });
    providerSockets.on("connection", (socket) =>
      providers.push(new FakeProvider(socket)),
    );
    const providerPort = await listen(providerServer);
    bridge = createRealtimeBridge({
      appUrl,
      publicOrigin,
      authToken: signingToken,
      bridgeSecret,
      apiKey,
      connectOpenAI: () => {
        providerConnects += 1;
        return new WebSocket(`ws://127.0.0.1:${providerPort}`);
      },
    });
    relay = createVoiceRelay({
      upstreamPort: port,
      allowSms: true,
      realtimeUpgrade: bridge.handleUpgrade,
    });
    relayUrl = `http://127.0.0.1:${await listen(relay)}`;
  },
  { timeout: 40_000 },
);

after(
  async () => {
    try {
      for (const socket of clients) socket.terminate();
      await bridge?.close();
      for (const socket of providerSockets?.clients || []) socket.terminate();
      if (providerSockets)
        await new Promise<void>((resolve) =>
          providerSockets!.close(() => resolve()),
        );
      await Promise.all([closeServer(relay), closeServer(providerServer)]);
    } finally {
      try {
        if (
          app &&
          appStopped &&
          !appSpawnFailed &&
          app.exitCode === null &&
          app.signalCode === null
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

async function ticketedCall(): Promise<Call> {
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;
  const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const form = { CallSid: callSid, From: callingNumber, To: receivingNumber };
  const material =
    `${publicOrigin}/api/webhooks/voice` +
    Object.keys(form)
      .sort()
      .map((key) => key + form[key as keyof typeof form])
      .join("");
  const request = () =>
    fetch(`${relayUrl}/api/webhooks/voice`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": createHmac("sha1", signingToken)
          .update(material)
          .digest("base64"),
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(5_000),
    });
  const response = await request();
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(
    xml,
    new RegExp(
      `<Connect><Stream url="${publicOrigin.replace("https:", "wss:")}${streamPath}">`,
    ),
  );
  const ticket = xml.match(
    /<Parameter name="ticket" value="([a-f0-9]{64})"\/>/,
  )?.[1];
  assert.ok(ticket);
  assert.doesNotMatch(
    xml,
    /realtime-integration-fake-(?:openai-key|server-only-secret)/,
  );
  assert.equal(
    await (await request()).text(),
    xml,
    "Twilio retries replay the same ticket",
  );
  return { callSid, streamSid, ticket, xml };
}

async function connect(
  signed = true,
): Promise<{ status: number; socket: WebSocket; messages: Inbox<Message> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      relayUrl.replace("http:", "ws:") + streamPath,
      {
        headers: signed
          ? {
              "x-twilio-signature": createHmac("sha1", signingToken)
                .update(publicOrigin + streamPath)
                .digest("base64"),
            }
          : {},
        handshakeTimeout: 3_000,
      },
    );
    clients.add(socket);
    const messages = new Inbox<Message>();
    socket.on("message", (raw) => {
      const message = object(JSON.parse(raw.toString()));
      messages.push(message);
      if (message.event === "mark") socket.send(JSON.stringify(message));
    });
    socket.once("open", () => resolve({ status: 101, socket, messages }));
    socket.once("unexpected-response", (request, response) => {
      response.resume();
      resolve({ status: response.statusCode!, socket, messages });
      request.destroy();
    });
    socket.on("error", reject);
  });
}

function start(socket: WebSocket, call: Call, ticket = call.ticket) {
  socket.send(
    JSON.stringify({
      event: "start",
      streamSid: call.streamSid,
      start: {
        streamSid: call.streamSid,
        callSid: call.callSid,
        customParameters: { ticket },
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          channels: 1,
        },
      },
    }),
  );
}

async function internal(body: Message, authorized = true) {
  return fetch(`${appUrl}/api/realtime/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${bridgeSecret}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

async function schedule(date = bookingDate): Promise<Availability> {
  const response = await fetch(`${appUrl}/api/availability?date=${date}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<Availability>;
}

test("production Realtime relay hides private HTTP, rejects unsigned upgrades, and validates tickets before connecting the provider", async () => {
  for (const path of [
    "/",
    "/admin",
    "/api/bookings",
    "/api/realtime/turn",
    streamPath,
  ]) {
    const response = await fetch(relayUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeSecret}`,
      },
      body: JSON.stringify({ op: "stop" }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 404, path);
    await response.text();
  }
  assert.equal((await connect(false)).status, 403);
  const call = await ticketedCall();
  const privateRequest = await internal({ op: "start", ...call }, false);
  assert.equal(privateRequest.status, 403);
  await privateRequest.text();
  const connectedBefore = providerConnects;
  const rejected = await connect();
  assert.equal(rejected.status, 101);
  start(rejected.socket, call, "0".repeat(64));
  await closed(rejected.socket);
  assert.equal(
    providerConnects,
    connectedBefore,
    "an invalid ticket cannot open an OpenAI connection",
  );
  assert.equal(
    (await schedule()).courts.flatMap((court) => court.bookings).length,
    0,
  );
});

test(
  "a scripted Realtime call crosses production HTTP and WebSocket, writes once after raw confirmation, and stops safely",
  { timeout: 20_000 },
  async () => {
    const call = await ticketedCall();
    const providerCursor = providers.values.length;
    const twilio = await connect();
    assert.equal(twilio.status, 101);
    start(twilio.socket, call);
    const provider = await providers.wait(
      () => true,
      "local provider connection",
      providerCursor,
    );
    const sessionUpdate = await provider.messages.wait(
      (message) => message.type === "session.update",
      "provider session configuration",
    );
    const audio = object(object(sessionUpdate.session).audio);
    assert.deepEqual(object(audio.input).format, { type: "audio/pcmu" });
    assert.deepEqual(object(audio.output).format, { type: "audio/pcmu" });
    await provider.prompts.wait(
      (prompt) => /您好，想预约球场还是查空档/.test(prompt),
      "booking greeting",
    );
    const output = await twilio.messages.wait(
      (message) => message.event === "media",
      "PCMU output to Twilio",
    );
    assert.equal(object(output.media).payload, silence);
    assert.equal(output.streamSid, call.streamSid);
    twilio.socket.send(
      JSON.stringify({
        event: "media",
        streamSid: call.streamSid,
        media: { track: "inbound", timestamp: "0", payload: silence },
      }),
    );
    const input = await provider.messages.wait(
      (message) => message.type === "input_audio_buffer.append",
      "PCMU input to provider",
    );
    assert.equal(input.audio, silence);

    provider.transcript(
      "item_booking",
      "我要预约2099年12月1日下午三点二号球场两个小时，我叫张三",
    );
    await provider.prompts.wait(
      (prompt) => /联系电话/.test(prompt),
      "contact question",
    );
    assert.equal(provider.toolResponses, 1);
    assert.equal(
      (await schedule()).courts.flatMap((court) => court.bookings).length,
      0,
    );
    provider.transcript("item_contact", "使用来电号码");
    const summary = await provider.prompts.wait(
      (prompt) => /确认请说确认预约/.test(prompt),
      "uncommitted booking review",
    );
    assert.match(summary, /预约人张三/);
    assert.match(summary, /联系电话/);
    assert.match(
      summary,
      /1号场/,
      "the server assigns court one despite caller/model court two",
    );
    assert.equal(
      (await schedule()).courts.flatMap((court) => court.bookings).length,
      0,
    );
    provider.transcript("item_confirm", "确认预约");
    const committed = await provider.prompts.wait(
      (prompt) => /预约成功/.test(prompt),
      "committed booking and management code",
    );
    assert.equal(
      provider.toolResponses,
      1,
      "contact and raw confirmation bypass model field interpretation",
    );
    const publicSchedule = await schedule();
    const bookings = publicSchedule.courts.flatMap((court) => court.bookings);
    assert.equal(bookings.length, 1);
    const booking = bookings[0];
    assert.equal(booking.customerName, "张三");
    assert.equal(booking.courtId, 1);
    assert.equal(booking.startsAt, "2099-12-01T04:00:00Z");
    assert.equal(
      Date.parse(booking.endsAt) - Date.parse(booking.startsAt),
      7_200_000,
    );
    const accessCode = spokenCredential(committed);
    assert.ok(accessCode && /^\d{10}$/.test(accessCode));
    const serialized = JSON.stringify(publicSchedule);
    assert.ok(
      !serialized.includes(callingNumber) && !serialized.includes(accessCode),
    );
    for (const privateField of [
      '"phone"',
      '"email"',
      '"accessCode"',
      '"accessHash"',
    ])
      assert.ok(!serialized.includes(privateField), privateField);
    const lookup = await fetch(`${appUrl}/api/bookings/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ id: booking.id, accessCode }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(lookup.status, 200);
    const privateBooking = ((await lookup.json()) as { booking: Booking })
      .booking;
    assert.equal(privateBooking.phone, callingNumber);
    assert.equal(privateBooking.source, "phone");
    assert.equal(privateBooking.customerName, "张三");
    assert.equal(privateBooking.durationHours, 2);

    // A new answer acts as a barrier: the duplicate confirmation precedes it on
    // the same provider socket and must not become a second booking operation.
    const promptCursor = provider.prompts.values.length;
    provider.transcript("item_confirm", "确认预约");
    provider.transcript("item_after_replay", "不确认");
    await provider.prompts.wait(
      () => true,
      "turn after duplicate ASR item",
      promptCursor,
    );
    assert.equal(provider.toolResponses, 1);
    assert.equal(
      (await schedule()).courts.flatMap((court) => court.bookings).length,
      1,
    );

    twilio.socket.send(
      JSON.stringify({ event: "stop", streamSid: call.streamSid }),
    );
    await closed(twilio.socket);
    await closed(provider.socket);
    // The bridge closes sockets before its asynchronous stop request completes.
    // A consumed-ticket replay only reads the cached greeting, so it can observe
    // the bridge's stop without changing the state we are trying to verify.
    const stopDeadline = Date.now() + 5_000;
    let stopped = false;
    while (Date.now() < stopDeadline) {
      const replay = await internal({
        op: "start",
        callSid: call.callSid,
        streamSid: call.streamSid,
        ticket: call.ticket,
      });
      await replay.text();
      if (replay.status === 409) {
        stopped = true;
        break;
      }
      assert.equal(replay.status, 200);
      await delay(25);
    }
    assert.ok(
      stopped,
      "Twilio stop must deactivate the production booking session",
    );
    for (const inputId of ["item_confirm", "item_after_stop"]) {
      const response = await internal({
        op: "turn",
        callSid: call.callSid,
        streamSid: call.streamSid,
        inputId,
        transcript: "确认预约",
      });
      assert.equal(
        response.status,
        409,
        "stopped sessions reject both replayed and new confirmations",
      );
      await response.text();
    }
    assert.equal(
      (await schedule()).courts.flatMap((court) => court.bookings).length,
      1,
    );
  },
);

test(
  "a completed provider response without a function call lets raw booking speech progress and commit once through production",
  { timeout: 20_000 },
  async () => {
    const date = "2099-12-02";
    const occupied = await fetch(`${appUrl}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: publicOrigin },
      body: JSON.stringify({
        courtId: 1,
        startLocal: `${date}T15:00`,
        durationHours: 2,
        customerName: "场地占用测试",
        phone: "+61400111111",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(occupied.status, 201);
    const occupiedBooking = (await occupied.json()).booking as Booking;
    const call = await ticketedCall();
    const providerCursor = providers.values.length;
    const twilio = await connect();
    assert.equal(twilio.status, 101);
    start(twilio.socket, call);
    const provider = await providers.wait(
      () => true,
      "provider for raw-speech booking",
      providerCursor,
    );
    provider.omitFunctionCalls = true;
    await provider.prompts.wait(
      (prompt) => /您好，想预约球场还是查空档/.test(prompt),
      "raw-speech booking greeting",
    );

    const allBookings = async () =>
      (await schedule(date)).courts.flatMap((court) => court.bookings);
    const bookings = async () =>
      (await allBookings()).filter(
        (booking) => booking.id !== occupiedBooking.id,
      );
    const answer = async (
      id: string,
      transcript: string,
      expected: RegExp,
      description: string,
    ) => {
      const cursor = provider.prompts.values.length;
      provider.transcript(id, transcript);
      const prompt = await provider.prompts.wait(
        (prompt) => expected.test(prompt),
        description,
        cursor,
      );
      assert.doesNotMatch(prompt, /想订一号场|选择.*球场/);
      return prompt;
    };

    assert.equal((await bookings()).length, 0);
    // Every interpretation response completes with output: []; each answer
    // must reach the real booking engine as its original raw transcription.
    await answer("raw_intent", "我要预定", /哪一天/, "booking date question");
    assert.equal(provider.toolResponses, 1);
    assert.equal((await bookings()).length, 0);
    const available = await answer(
      "raw_date",
      // Repeating the same date in another format is a clarification, just as
      // saying "明天11月13号" on November 12 is one requested calendar day.
      "2099年12月2日，也就是2099-12-02",
      /几点开始/,
      "start time question directly after the raw date",
    );
    assert.doesNotMatch(available, /想订一号场|想查一号场/);
    assert.equal((await bookings()).length, 0);
    await answer("raw_hour", "下午三点", /几个小时/, "duration question");
    assert.equal((await bookings()).length, 0);
    await answer(
      "raw_duration",
      "默认",
      /预约人叫什么名字/,
      "public name question",
    );
    assert.equal((await bookings()).length, 0);
    await answer("raw_name", "我叫李四", /联系电话/, "contact question");
    assert.equal((await bookings()).length, 0);
    assert.equal(provider.toolResponses, 5);
    const review = await answer(
      "raw_contact",
      "使用来电号码",
      /确认请说确认预约/,
      "uncommitted raw-speech booking review",
    );
    assert.match(review, /预约人李四/);
    assert.match(review, /两小时/);
    assert.match(
      review,
      /2号场/,
      "court one is occupied for the requested full interval",
    );
    assert.equal((await bookings()).length, 0);
    await answer(
      "raw_confirm",
      "确认预约",
      /预约成功/,
      "raw-speech booking committed after confirmation",
    );
    assert.equal(
      provider.toolResponses,
      5,
      "contact and confirmation bypass the provider's missing function calls",
    );
    const committed = await bookings();
    assert.equal(committed.length, 1);
    assert.equal(committed[0].customerName, "李四");
    assert.equal(committed[0].courtId, 2);
    const completeSchedule = await allBookings();
    assert.equal(completeSchedule.length, 2);
    assert.ok(
      completeSchedule.some(
        (booking) => booking.id === occupiedBooking.id && booking.courtId === 1,
      ),
    );
    assert.equal(committed[0].startsAt, "2099-12-02T04:00:00Z");
    assert.equal(
      Date.parse(committed[0].endsAt) - Date.parse(committed[0].startsAt),
      7_200_000,
    );

    // A following raw answer is a barrier for the duplicate confirmation.
    provider.transcript("raw_confirm", "确认预约");
    await answer(
      "raw_after_replay",
      "不确认",
      /还需要预约球场或查空档/,
      "turn after replay",
    );
    assert.equal((await bookings()).length, 1);
    twilio.socket.send(
      JSON.stringify({ event: "stop", streamSid: call.streamSid }),
    );
    await closed(twilio.socket);
    await closed(provider.socket);
  },
);
