import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { createRealtimeBridge } from "../scripts/realtime-bridge.mjs";

const PATH = "/api/realtime/voice";
const PUBLIC_ORIGIN = "https://courts.example";
const AUTH_TOKEN = "local-realtime-test-twilio-token";
const BRIDGE_SECRET = "local-realtime-test-private-bridge-secret";
const API_KEY = "local-realtime-test-openai-key";
const CALL_SID = `CA${"a".repeat(32)}`;
const STREAM_SID = `MZ${"b".repeat(32)}`;
const TICKET = "c".repeat(64);
const WELCOME = "欢迎，请问您要查询还是预约网球场？";
const NEXT_PROMPT = "请告诉我您的联系电话。";

type Message = Record<string, unknown>;
type AppReply = { status?: number; body?: Message };
type AppRequest = {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: Message;
};

function object(value: unknown): Message {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Message;
}

function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => object(current)[key], value);
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
      }, 2_000);
      this.events.on("value", check);
      check();
    });
  }
}

class SocketProbe {
  readonly inbox = new Inbox<Message>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) =>
      this.inbox.push(object(JSON.parse(raw.toString()))),
    );
    socket.on("error", () => {});
  }

  send(message: Message) {
    this.socket.send(JSON.stringify(message));
  }

  wait(type: string, after = 0) {
    return this.inbox.wait((message) => message.type === type, type, after);
  }

  waitEvent(event: string, after = 0) {
    return this.inbox.wait((message) => message.event === event, event, after);
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closed(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket did not close")),
      2_000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function signature(scheme: "https" | "wss" = "https", path = PATH) {
  return createHmac("sha1", AUTH_TOKEN)
    .update(`${PUBLIC_ORIGIN.replace("https:", `${scheme}:`)}${path}`)
    .digest("base64");
}

function startEvent(overrides: Message = {}): Message {
  return {
    event: "start",
    streamSid: STREAM_SID,
    start: {
      streamSid: STREAM_SID,
      callSid: CALL_SID,
      customParameters: { ticket: TICKET },
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      ...overrides,
    },
  };
}

function interpretation(overrides: Message = {}): Message {
  return {
    scope: "booking",
    action: "book",
    date: "2099-12-01",
    court: 2,
    hour: "15",
    duration: 2,
    name: "张三",
    correction: null,
    ...overrides,
  };
}

async function setup(
  t: TestContext,
  reply?: (request: AppRequest) => AppReply | Promise<AppReply>,
) {
  const appRequests = new Inbox<AppRequest>();
  const app = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      void (async () => {
        const request: AppRequest = {
          path: req.url!,
          method: req.method!,
          headers: req.headers,
          body: object(JSON.parse(Buffer.concat(chunks).toString())),
        };
        appRequests.push(request);
        const result = (await reply?.(request)) ?? {
          body: {
            prompt: request.body.op === "start" ? WELCOME : NEXT_PROMPT,
            context: {
              channel: "phone",
              step: request.body.op === "start" ? "menu" : "contact",
            },
            closed: request.body.op === "stop",
          },
        };
        res.writeHead(result.status ?? 200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(result.body ?? {}));
      })().catch(() => {
        res.writeHead(500);
        res.end("mock application failed");
      });
    });
  });
  const appPort = await listen(app);
  const aiServer = createServer();
  const aiWss = new WebSocketServer({ server: aiServer });
  const aiPort = await listen(aiServer);
  const aiConnections = new Inbox<SocketProbe>();
  aiWss.on("connection", (socket) =>
    aiConnections.push(new SocketProbe(socket)),
  );
  const outbound: { url: string; options: ClientOptions | undefined }[] = [];
  const bridge = createRealtimeBridge({
    appUrl: `http://127.0.0.1:${appPort}`,
    publicOrigin: PUBLIC_ORIGIN,
    authToken: AUTH_TOKEN,
    bridgeSecret: BRIDGE_SECRET,
    apiKey: API_KEY,
    model: "gpt-realtime-1.5",
    voice: "marin",
    transcriptionModel: "gpt-transcribe",
    connectOpenAI: (url: string, options?: ClientOptions) => {
      outbound.push({ url, options });
      return new WebSocket(`ws://127.0.0.1:${aiPort}`, {
        ...options,
        agent: undefined,
      });
    },
  });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", bridge.handleUpgrade);
  const port = await listen(server);
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    await bridge.close();
    for (const socket of aiWss.clients) socket.terminate();
    await new Promise<void>((resolve) => aiWss.close(() => resolve()));
    await Promise.all([
      closeServer(server),
      closeServer(aiServer),
      closeServer(app),
    ]);
  });

  async function connect(
    options: {
      path?: string;
      signature?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    return new Promise<{ status: number; probe?: SocketProbe }>(
      (resolve, reject) => {
        const token =
          options.signature === undefined ? signature() : options.signature;
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}${options.path ?? PATH}`,
          {
            headers: {
              ...(token === null ? {} : { "x-twilio-signature": token }),
              ...options.headers,
            },
            handshakeTimeout: 2_000,
          },
        );
        clients.add(socket);
        const probe = new SocketProbe(socket);
        socket.once("open", () => resolve({ status: 101, probe }));
        socket.once("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          resolve({ status: response.statusCode! });
        });
        socket.once("error", reject);
      },
    );
  }

  async function start() {
    const { status, probe: twilio } = await connect();
    assert.equal(status, 101);
    assert.ok(twilio);
    twilio.send(startEvent());
    const ai = await aiConnections.wait(() => true, "OpenAI connection");
    const session = await ai.wait("session.update");
    ai.send({ type: "session.updated", session: session.session });
    const greeting = await ai.wait("response.create");
    ai.send({
      type: "response.created",
      response: {
        ...object(greeting.response),
        id: "resp_greeting",
        status: "in_progress",
        output: [],
      },
    });
    return { twilio, ai, session, greeting };
  }

  return { bridge, connect, start, appRequests, aiConnections, outbound };
}

function toolCreate(message: Message) {
  return (
    message.type === "response.create" &&
    field(message, "response", "tool_choice") !== "none"
  );
}

async function requestTool(
  ai: SocketProbe,
  transcript: string,
  itemId = "item_user_1",
  responseId = "resp_tool_1",
) {
  const after = ai.inbox.values.length;
  const greeting = ai.inbox.values.find(
    (message) =>
      message.type === "response.create" &&
      field(message, "response", "tool_choice") === "none",
  );
  assert.ok(greeting);
  ai.send({
    type: "response.done",
    response: {
      ...object(greeting.response),
      id: "resp_greeting",
      status: "completed",
      output: [],
    },
  });
  ai.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
  const request = await ai.inbox.wait(
    toolCreate,
    "required booking tool response",
    after,
  );
  const response = {
    ...object(request.response),
    id: responseId,
    status: "in_progress",
    output: [],
  };
  ai.send({ type: "response.created", response });
  return { request, response };
}

function completeTool(
  ai: SocketProbe,
  response: Message,
  args = interpretation(),
  status = "completed",
) {
  ai.send({
    type: "response.done",
    response: {
      ...response,
      status,
      output: [
        {
          type: "function_call",
          name: "booking_turn",
          call_id: "tool_call_1",
          arguments: JSON.stringify(args),
        },
      ],
    },
  });
}

test("Realtime upgrade checks the fixed signed URL and exposes only the stream path", async (t) => {
  const fixture = await setup(t);
  for (const token of [null, "incorrect", "x".repeat(257)]) {
    assert.equal((await fixture.connect({ signature: token })).status, 403);
  }
  for (const path of [
    "/",
    "/admin",
    "/api/realtime/turn",
    `${PATH}/`,
    `${PATH}?ticket=${TICKET}`,
    "/api/realtime/%76oice",
  ]) {
    assert.equal(
      (await fixture.connect({ path, signature: signature("https", path) }))
        .status,
      404,
      path,
    );
  }
  for (const scheme of ["https", "wss"] as const) {
    const result = await fixture.connect({
      signature: signature(scheme),
      headers: {
        host: "spoofed.invalid",
        "x-forwarded-host": "spoofed.invalid",
        "x-forwarded-proto": "http",
      },
    });
    assert.equal(result.status, 101);
    result.probe!.socket.close();
    await closed(result.probe!.socket);
  }
  assert.equal(fixture.appRequests.values.length, 0);
  assert.equal(fixture.outbound.length, 0);
});

test("only a ticket accepted by the private app can open OpenAI, after the validated Twilio start", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(t, async () => {
    await gate;
    return { status: 403, body: { error: "Invalid ticket" } };
  });
  const { probe: twilio } = await fixture.connect();
  assert.ok(twilio);
  assert.equal(fixture.outbound.length, 0);
  twilio.send(startEvent());
  const start = await fixture.appRequests.wait(
    () => true,
    "private ticket validation",
  );
  assert.equal(start.path, "/api/realtime/turn");
  assert.equal(start.method, "POST");
  assert.equal(start.headers.authorization, `Bearer ${BRIDGE_SECRET}`);
  assert.deepEqual(start.body, {
    op: "start",
    ticket: TICKET,
    callSid: CALL_SID,
    streamSid: STREAM_SID,
  });
  assert.equal(fixture.outbound.length, 0);
  release!();
  await closed(twilio.socket);
  assert.equal(fixture.outbound.length, 0);
});

test("Twilio audio arriving during private ticket validation is buffered until the OpenAI session is ready", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(t, async (request) => {
    if (request.body.op === "start") await gate;
    return {
      body: {
        prompt: WELCOME,
        context: { channel: "phone", step: "menu" },
        closed: request.body.op === "stop",
      },
    };
  });
  const { probe: twilio } = await fixture.connect();
  assert.ok(twilio);
  twilio.send(startEvent());
  await fixture.appRequests.wait(
    (value) => value.body.op === "start",
    "in-flight ticket validation",
  );
  const payload = Buffer.alloc(160, 255).toString("base64");
  twilio.send({
    event: "media",
    streamSid: STREAM_SID,
    media: { track: "inbound", timestamp: "20", payload },
  });
  await delay(25);
  assert.equal(twilio.socket.readyState, WebSocket.OPEN);
  assert.equal(fixture.outbound.length, 0);
  release!();
  const ai = await fixture.aiConnections.wait(
    () => true,
    "OpenAI after accepted ticket",
  );
  const session = await ai.wait("session.update");
  assert.equal(
    ai.inbox.values.filter(
      (message) => message.type === "input_audio_buffer.append",
    ).length,
    0,
  );
  ai.send({ type: "session.updated", session: session.session });
  assert.equal((await ai.wait("input_audio_buffer.append")).audio, payload);
});

test("Twilio start rejects incompatible audio before contacting the app or OpenAI", async (t) => {
  const fixture = await setup(t);
  for (const mediaFormat of [
    { encoding: "audio/pcm", sampleRate: 8000, channels: 1 },
    { encoding: "audio/x-mulaw", sampleRate: 16000, channels: 1 },
    { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 2 },
  ]) {
    const { probe: twilio } = await fixture.connect();
    assert.ok(twilio);
    twilio.send(startEvent({ mediaFormat }));
    await closed(twilio.socket);
  }
  assert.equal(fixture.appRequests.values.length, 0);
  assert.equal(fixture.outbound.length, 0);
});

test("GA Realtime uses PCMU, trusted Mandarin transcription and manual responses, forwarding original audio bytes", async (t) => {
  const fixture = await setup(t);
  const { twilio, ai, session, greeting } = await fixture.start();
  assert.equal(fixture.outbound.length, 1);
  const url = new URL(fixture.outbound[0].url);
  assert.equal(url.origin, "wss://api.openai.com");
  assert.equal(url.pathname, "/v1/realtime");
  assert.equal(url.searchParams.get("model"), "gpt-realtime-1.5");
  assert.equal(
    object(fixture.outbound[0].options?.headers).Authorization,
    `Bearer ${API_KEY}`,
  );
  assert.equal(
    field(session, "session", "audio", "input", "format", "type"),
    "audio/pcmu",
  );
  assert.equal(
    field(session, "session", "audio", "output", "format", "type"),
    "audio/pcmu",
  );
  assert.equal(field(session, "session", "audio", "output", "voice"), "marin");
  assert.equal(
    field(session, "session", "audio", "input", "transcription", "model"),
    "gpt-transcribe",
  );
  assert.equal(
    field(session, "session", "audio", "input", "transcription", "language"),
    "zh",
  );
  assert.equal(
    field(session, "session", "audio", "input", "turn_detection", "type"),
    "server_vad",
  );
  assert.equal(
    field(
      session,
      "session",
      "audio",
      "input",
      "turn_detection",
      "create_response",
    ),
    false,
  );
  assert.deepEqual(field(greeting, "response", "output_modalities"), ["audio"]);
  assert.equal(field(greeting, "response", "tool_choice"), "none");
  assert.ok(
    String(field(greeting, "response", "instructions")).includes(WELCOME),
  );

  const input = Buffer.from([0, 1, 127, 128, 254, 255]).toString("base64");
  twilio.send({
    event: "media",
    streamSid: STREAM_SID,
    media: { track: "inbound", chunk: "1", timestamp: "20", payload: input },
  });
  assert.equal((await ai.wait("input_audio_buffer.append")).audio, input);
  const output = Buffer.from([254, 128, 1, 0]).toString("base64");
  ai.send({
    type: "response.output_audio.delta",
    response_id: "resp_greeting",
    item_id: "item_audio_1",
    delta: output,
  });
  const media = await twilio.waitEvent("media");
  assert.equal(media.streamSid, STREAM_SID);
  assert.equal(field(media, "media", "payload"), output);
});

test("only a completed required tool turn reaches the engine, retaining the trusted ASR and deduplicating retries", async (t) => {
  const fixture = await setup(t);
  const { ai } = await fixture.start();
  completeTool(ai, {
    id: "resp_unsolicited",
    status: "in_progress",
    output: [],
  });
  await delay(30);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "turn")
      .length,
    0,
  );
  const transcript = "帮我安排十二月一日下午三点二号场两个小时，我叫张三。";
  const { request, response } = await requestTool(ai, transcript);
  assert.deepEqual(field(request, "response", "output_modalities"), ["text"]);
  assert.deepEqual(field(request, "response", "tool_choice"), {
    type: "function",
    name: "booking_turn",
  });
  ai.send({
    type: "response.function_call_arguments.done",
    response_id: response.id,
    call_id: "tool_call_1",
    name: "booking_turn",
    arguments: JSON.stringify(interpretation()),
  });
  await delay(30);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "turn")
      .length,
    0,
  );
  const after = ai.inbox.values.length;
  completeTool(ai, response);
  const turn = await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "completed private turn",
  );
  assert.equal(turn.body.inputId, "item_user_1");
  assert.equal(turn.body.transcript, transcript);
  assert.deepEqual(turn.body.interpretation, interpretation());
  assert.equal(turn.body.callSid, CALL_SID);
  assert.equal(turn.body.streamSid, STREAM_SID);
  const spoken = await ai.inbox.wait(
    (value) =>
      value.type === "response.create" &&
      field(value, "response", "tool_choice") === "none",
    "authoritative engine prompt",
    after,
  );
  assert.ok(
    String(field(spoken, "response", "instructions")).includes(NEXT_PROMPT),
  );
  completeTool(ai, response);
  ai.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_user_1",
    transcript: "确认预约",
  });
  await delay(40);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "turn")
      .length,
    1,
  );
});

test("model arguments preserve the trusted ASR and cannot introduce top-level confirmation fields", async (t) => {
  const fixture = await setup(t);
  const { ai } = await fixture.start();
  const { response } = await requestTool(
    ai,
    "我还需要想一想",
    "item_uncertain",
  );
  completeTool(
    ai,
    response,
    interpretation({ transcript: "确认预约", digits: "1", confirmed: true }),
  );
  const turn = await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "private turn retaining raw ASR",
  );
  assert.equal(turn.body.transcript, "我还需要想一想");
  assert.equal(turn.body.digits, undefined);
  assert.equal(turn.body.confirmed, undefined);
});

test("raw spoken confirmation bypasses model interpretation and reaches the deterministic engine unchanged", async (t) => {
  const fixture = await setup(t);
  const { ai, greeting } = await fixture.start();
  ai.send({
    type: "response.done",
    response: {
      ...object(greeting.response),
      id: "resp_greeting",
      status: "completed",
      output: [],
    },
  });
  ai.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_confirmation",
    transcript: "确认预约",
  });
  const turn = await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "raw private confirmation turn",
  );
  assert.equal(turn.body.inputId, "item_confirmation");
  assert.equal(turn.body.transcript, "确认预约");
  assert.equal(turn.body.interpretation ?? null, null);
  assert.equal(ai.inbox.values.filter(toolCreate).length, 0);
});

test("caller barge-in clears buffered Twilio audio, cancels the model and truncates the played assistant item", async (t) => {
  const fixture = await setup(t);
  const { twilio, ai } = await fixture.start();
  twilio.send({
    event: "media",
    streamSid: STREAM_SID,
    media: {
      timestamp: "100",
      payload: Buffer.alloc(160, 255).toString("base64"),
    },
  });
  await ai.wait("input_audio_buffer.append");
  ai.send({
    type: "response.output_audio.delta",
    response_id: "resp_greeting",
    item_id: "item_assistant",
    delta: Buffer.alloc(1600, 127).toString("base64"),
  });
  await twilio.waitEvent("media");
  const after = ai.inbox.values.length;
  twilio.send({
    event: "media",
    streamSid: STREAM_SID,
    media: {
      timestamp: "160",
      payload: Buffer.alloc(160, 255).toString("base64"),
    },
  });
  await ai.wait("input_audio_buffer.append", after);
  ai.send({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 160,
    item_id: "item_interrupt",
  });
  const clear = await twilio.waitEvent("clear");
  assert.equal(clear.streamSid, STREAM_SID);
  await ai.wait("response.cancel");
  const truncate = await ai.wait("conversation.item.truncate");
  assert.equal(truncate.item_id, "item_assistant");
  assert.equal(truncate.content_index, 0);
  assert.equal(truncate.audio_end_ms, 60);
  const count = twilio.inbox.values.filter(
    (value) => value.event === "media",
  ).length;
  ai.send({
    type: "response.output_audio.delta",
    response_id: "resp_greeting",
    item_id: "item_assistant",
    delta: Buffer.alloc(160, 127).toString("base64"),
  });
  await delay(30);
  assert.equal(
    twilio.inbox.values.filter((value) => value.event === "media").length,
    count,
  );
});

test("cancelled and incomplete tool output never calls the engine; DTMF uses the private engine without a model tool", async (t) => {
  const fixture = await setup(t);
  const { twilio, ai } = await fixture.start();
  const { response } = await requestTool(ai, "我想订二号场");
  completeTool(ai, response, interpretation(), "cancelled");
  await delay(30);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "turn")
      .length,
    0,
  );
  const incomplete = await requestTool(
    ai,
    "我想订一号场",
    "item_incomplete",
    "resp_tool_incomplete",
  );
  completeTool(
    ai,
    incomplete.response,
    interpretation({ court: 1 }),
    "incomplete",
  );
  await delay(30);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "turn")
      .length,
    0,
  );
  const tools = ai.inbox.values.filter(toolCreate).length;
  twilio.send({
    event: "dtmf",
    streamSid: STREAM_SID,
    dtmf: { track: "inbound_track", digit: "1" },
  });
  const dtmf = await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "private DTMF turn",
  );
  assert.equal(dtmf.body.digits, "1");
  assert.equal(dtmf.body.transcript, "");
  assert.equal(dtmf.body.interpretation ?? null, null);
  assert.equal(ai.inbox.values.filter(toolCreate).length, tools);
});

test("a silent field tool preserves the first sentence while the caller adds a second sentence", async (t) => {
  const fixture = await setup(t, (request) => ({
    body: {
      prompt: request.body.op === "start" ? WELCOME : NEXT_PROMPT,
      context:
        request.body.op === "start"
          ? { channel: "phone", step: "menu" }
          : { channel: "phone", step: "date", action: "book", court: 2 },
      closed: request.body.op === "stop",
    },
  }));
  const { ai } = await fixture.start();
  const { response } = await requestTool(ai, "我想订二号场");
  const beforeSecondSentence = ai.inbox.values.length;
  ai.send({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 500,
    item_id: "item_second_sentence",
  });
  completeTool(
    ai,
    response,
    interpretation({ date: null, hour: null, duration: null, name: null }),
  );
  const first = await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "first sentence fields applied",
  );
  assert.equal(first.body.inputId, "item_user_1");
  assert.equal(first.body.transcript, "我想订二号场");
  assert.equal(field(first.body, "interpretation", "action"), "book");
  assert.equal(field(first.body, "interpretation", "court"), 2);
  await ai.wait("conversation.item.create", beforeSecondSentence);
  assert.equal(
    ai.inbox.values
      .slice(beforeSecondSentence)
      .filter((value) => value.type === "response.cancel").length,
    0,
  );
  assert.equal(
    ai.inbox.values
      .slice(beforeSecondSentence)
      .filter((value) => value.type === "response.create").length,
    0,
  );
  ai.send({
    type: "input_audio_buffer.speech_stopped",
    item_id: "item_second_sentence",
    audio_end_ms: 1100,
  });
  ai.send({
    type: "input_audio_buffer.committed",
    item_id: "item_second_sentence",
    previous_item_id: "item_user_1",
  });
  ai.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_second_sentence",
    transcript: "十二月一日下午三点打两个小时，我叫张三",
  });
  const secondRequest = await ai.inbox.wait(
    toolCreate,
    "second sentence interpretation after first applied",
    beforeSecondSentence,
  );
  assert.ok(
    String(field(secondRequest, "response", "instructions")).includes(
      '"action":"book"',
    ),
  );
  assert.ok(
    String(field(secondRequest, "response", "instructions")).includes(
      '"court":2',
    ),
  );
  const secondResponse = {
    ...object(secondRequest.response),
    id: "resp_tool_second",
    status: "in_progress",
    output: [],
  };
  ai.send({ type: "response.created", response: secondResponse });
  completeTool(
    ai,
    secondResponse,
    interpretation({ action: null, court: null }),
  );
  const second = await fixture.appRequests.wait(
    (value) => value.body.inputId === "item_second_sentence",
    "second sentence fields applied",
  );
  assert.equal(
    second.body.transcript,
    "十二月一日下午三点打两个小时，我叫张三",
  );
  assert.equal(field(second.body, "interpretation", "date"), "2099-12-01");
  assert.deepEqual(
    fixture.appRequests.values
      .filter((value) => value.body.op === "turn")
      .map((value) => value.body.inputId),
    ["item_user_1", "item_second_sentence"],
  );
});

test("an engine result waits for the caller to finish speaking and the next ASR turn before requesting speech", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finalPrompt = "请确认预约日期、时间和来电号码。";
  const fixture = await setup(t, async (request) => {
    if (request.body.op === "turn" && request.body.inputId === "item_user_1")
      await gate;
    return {
      body: {
        prompt:
          request.body.op === "start"
            ? WELCOME
            : request.body.inputId === "item_user_1"
              ? NEXT_PROMPT
              : finalPrompt,
        context: {
          channel: "phone",
          step: request.body.op === "start" ? "menu" : "contact",
        },
        closed: request.body.op === "stop",
      },
    };
  });
  const { ai, twilio } = await fixture.start();
  const { response } = await requestTool(ai, "我想订二号场");
  completeTool(ai, response);
  await fixture.appRequests.wait(
    (value) => value.body.op === "turn",
    "gated first engine turn",
  );
  const after = ai.inbox.values.length;
  const clearAfter = twilio.inbox.values.length;
  ai.send({
    type: "input_audio_buffer.speech_started",
    item_id: "item_contact_answer",
    audio_start_ms: 500,
  });
  await twilio.waitEvent("clear", clearAfter);
  release!();
  await ai.wait("conversation.item.create", after);
  assert.equal(
    ai.inbox.values
      .slice(after)
      .filter((value) => value.type === "response.create").length,
    0,
  );
  ai.send({
    type: "input_audio_buffer.speech_stopped",
    item_id: "item_contact_answer",
    audio_end_ms: 1100,
  });
  ai.send({
    type: "input_audio_buffer.committed",
    item_id: "item_contact_answer",
    previous_item_id: "item_user_1",
  });
  ai.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_contact_answer",
    transcript: "使用来电号码",
  });
  await fixture.appRequests.wait(
    (value) => value.body.inputId === "item_contact_answer",
    "second raw turn after speaking",
  );
  const speech = await ai.inbox.wait(
    (value) =>
      value.type === "response.create" &&
      field(value, "response", "tool_choice") === "none",
    "final authoritative prompt after caller stops",
    after,
  );
  assert.ok(
    String(field(speech, "response", "instructions")).includes(finalPrompt),
  );
  assert.equal(
    ai.inbox.values
      .slice(after)
      .filter(
        (value) =>
          value.type === "response.create" &&
          field(value, "response", "tool_choice") === "none",
      ).length,
    1,
  );
});

test("Twilio stop closes OpenAI and persists a private stop exactly once", async (t) => {
  const fixture = await setup(t);
  const { twilio, ai } = await fixture.start();
  twilio.send({
    event: "stop",
    streamSid: STREAM_SID,
    stop: { callSid: CALL_SID },
  });
  await Promise.all([closed(twilio.socket), closed(ai.socket)]);
  const stop = await fixture.appRequests.wait(
    (value) => value.body.op === "stop",
    "private stream stop",
  );
  assert.equal(stop.body.callSid, CALL_SID);
  assert.equal(stop.body.streamSid, STREAM_SID);
  await delay(30);
  assert.equal(
    fixture.appRequests.values.filter((value) => value.body.op === "stop")
      .length,
    1,
  );
});

test("a caller disconnect during ticket validation still stops a subsequently accepted private session", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(t, async (request) => {
    if (request.body.op === "start") await gate;
    return {
      body: {
        prompt: WELCOME,
        context: { channel: "phone", step: "menu" },
        closed: request.body.op === "stop",
      },
    };
  });
  const { probe: twilio } = await fixture.connect();
  assert.ok(twilio);
  twilio.send(startEvent());
  await fixture.appRequests.wait(
    (value) => value.body.op === "start",
    "in-flight private ticket validation",
  );
  twilio.socket.close();
  await closed(twilio.socket);
  release!();
  await fixture.appRequests.wait(
    (value) => value.body.op === "stop",
    "cleanup of late successful private start",
  );
  assert.equal(fixture.outbound.length, 0);
});

test("OpenAI errors close both sockets and stop the private session without speaking an invented outcome", async (t) => {
  const fixture = await setup(t);
  const { twilio, ai } = await fixture.start();
  ai.send({
    type: "error",
    error: {
      type: "server_error",
      code: "server_error",
      message: "local mock failure",
    },
  });
  await Promise.all([closed(twilio.socket), closed(ai.socket)]);
  await fixture.appRequests.wait(
    (value) => value.body.op === "stop",
    "private error cleanup",
  );
  assert.equal(
    twilio.inbox.values.filter((value) => value.event === "media").length,
    0,
  );
});
