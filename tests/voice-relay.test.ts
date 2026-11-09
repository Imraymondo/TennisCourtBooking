import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { test, type TestContext } from "node:test";
import { createVoiceRelay } from "../scripts/voice-relay.mjs";

const voicePath = "/api/webhooks/voice";
const smsPath = "/api/webhooks/sms";
const signature = "local-relay-test-signature-not-a-real-credential";
const formHeaders = {
  "content-type": "application/x-www-form-urlencoded; charset=utf-8",
  "x-twilio-signature": signature,
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function setup(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: {
    deadlineMs?: number;
    maxBodyBytes?: number;
    allowSms?: boolean;
  } = {},
) {
  const upstream = createServer(handler);
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const relay = createVoiceRelay({ upstreamPort, ...options });
  const port = await listen(relay);
  t.after(() => close(relay));
  return { port, upstreamPort };
}

type Reply = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

function send(
  port: number,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string | number | undefined>;
    chunks?: Buffer[];
    leaveBodyOpen?: boolean;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(
      Object.entries({ ...formHeaders, ...options.headers }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path ?? voicePath,
        method: options.method ?? "POST",
        headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          outgoing.destroy();
          resolve({
            status: incoming.statusCode!,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(2_000, () =>
      outgoing.destroy(new Error("relay test request timed out")),
    );
    for (const chunk of options.chunks ?? []) outgoing.write(chunk);
    if (!options.leaveBodyOpen) outgoing.end();
    else outgoing.flushHeaders();
  });
}

for (const channel of ["voice", "sms"]) {
  test(`${channel} relay preserves signed form bytes and encoded query while stripping browser credentials and forwarding headers`, async (t) => {
    const body = Buffer.from(
      channel === "sms"
        ? "Body=%E6%9F%A5%E8%AF%A2+2031-02-01+%2B&MessageSid=SMlocaltest&From=%2B61400123456&To=%2B61255550100"
        : "Digits=01&SpeechResult=%E5%BC%A0%E4%B8%89+%2B&From=%2B61400123456&To=%2B61255550100",
    );
    const target = `${channel === "sms" ? smsPath : voicePath}?turn=5dff64a5-b5cf-4b2a-8dfb-4d97ee349bc0&encoded=%2B+%20&encoded=second`;
    let seen:
      | { path: string; headers: IncomingMessage["headers"]; body: Buffer }
      | undefined;
    const xml = '<?xml version="1.0"?><Response><Say>本地测试</Say></Response>';
    const { port, upstreamPort } = await setup(
      t,
      (req, res) => {
        const received: Buffer[] = [];
        req.on("data", (chunk) => received.push(chunk));
        req.once("end", () => {
          seen = {
            path: req.url!,
            headers: req.headers,
            body: Buffer.concat(received),
          };
          res.writeHead(200, {
            "content-type": "text/xml; charset=utf-8",
            "set-cookie": "local-test-cookie=unused",
            location: "https://example.invalid/",
            "x-upstream-only": "private",
          });
          res.end(xml);
        });
      },
      { allowSms: channel === "sms" },
    );
    const reply = await send(port, {
      path: target,
      headers: {
        host: "untrusted.example",
        cookie: "local-test-cookie=unused",
        authorization: "Bearer local-test-placeholder",
        origin: "https://untrusted.example",
        "x-forwarded-host": "untrusted.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.2",
        forwarded: "for=192.0.2.3;host=untrusted.example;proto=https",
        "x-api-key": "local-test-placeholder",
        "x-postmark-inbound-secret": "local-test-placeholder",
        "content-length": body.length,
      },
      chunks: [body],
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), xml);
    assert.equal(reply.headers["content-type"], "text/xml; charset=utf-8");
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(reply.headers["set-cookie"], undefined);
    assert.equal(reply.headers.location, undefined);
    assert.equal(reply.headers["x-upstream-only"], undefined);
    assert.ok(seen);
    assert.equal(seen.path, target);
    assert.deepEqual(seen.body, body);
    assert.equal(seen.headers["x-twilio-signature"], signature);
    assert.equal(seen.headers["content-type"], formHeaders["content-type"]);
    assert.equal(seen.headers["content-length"], String(body.length));
    assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`);
    for (const header of [
      "cookie",
      "authorization",
      "origin",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "x-real-ip",
      "forwarded",
      "x-api-key",
      "x-postmark-inbound-secret",
    ]) {
      assert.equal(
        seen.headers[header],
        undefined,
        `relay must strip ${header}`,
      );
    }
  });
}

test("only POST on the literal voice webhook target is forwarded", async (t) => {
  let upstreamRequests = 0;
  const { port } = await setup(t, (_req, res) => {
    upstreamRequests++;
    res.end("unexpected");
  });
  for (const path of [
    "/",
    "/admin",
    "/api/admin/login",
    "/api/bookings",
    "/api/webhooks/sms",
    "/api/webhooks/email",
    `${voicePath}/`,
    "/api/%77ebhooks/voice",
    "/api/../api/webhooks/voice",
    "http://example.invalid/api/webhooks/voice",
  ]) {
    assert.equal((await send(port, { path })).status, 404, path);
  }
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const reply = await send(port, { method });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.allow, "POST");
  }
  assert.equal(
    (await send(port, { headers: { "x-twilio-signature": undefined } })).status,
    403,
  );
  assert.equal(
    (await send(port, { headers: { "x-twilio-signature": "x".repeat(257) } }))
      .status,
    403,
  );
  assert.equal(
    (await send(port, { headers: { "content-type": "application/json" } }))
      .status,
    415,
  );
  assert.equal(upstreamRequests, 0);
});

test("SMS opt-in keeps method, signature, content type and literal-path restrictions without exposing other routes", async (t) => {
  const upstreamPaths: string[] = [];
  const { port } = await setup(
    t,
    (req, res) => {
      upstreamPaths.push(req.url!);
      req.resume();
      res.end("allowed webhook");
    },
    { allowSms: true },
  );

  for (const path of [
    "/",
    "/admin",
    "/api/admin/login",
    "/api/bookings",
    "/api/webhooks/email",
    `${smsPath}/`,
    "/api/%77ebhooks/sms",
    "/api/webhooks/%73ms",
    "/api/../api/webhooks/sms",
    "http://example.invalid/api/webhooks/sms",
  ]) {
    assert.equal((await send(port, { path })).status, 404, path);
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const reply = await send(port, { path: smsPath, method });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.allow, "POST");
  }
  for (const value of [undefined, "", "x".repeat(257)]) {
    const reply = await send(port, {
      path: smsPath,
      headers: { "x-twilio-signature": value },
    });
    assert.equal(reply.status, 403);
  }
  for (const value of [undefined, "application/json", "text/plain"]) {
    const reply = await send(port, {
      path: smsPath,
      headers: { "content-type": value },
    });
    assert.equal(reply.status, 415);
  }
  assert.deepEqual(
    upstreamPaths,
    [],
    "rejected requests must never reach the app",
  );

  for (const path of [voicePath, smsPath]) {
    assert.equal((await send(port, { path })).status, 200);
  }
  assert.deepEqual(upstreamPaths, [voicePath, smsPath]);
});

test("declared and chunked oversized request bodies are rejected before contacting the application", async (t) => {
  let upstreamRequests = 0;
  const { port } = await setup(
    t,
    (_req, res) => {
      upstreamRequests++;
      res.end("unexpected");
    },
    { maxBodyBytes: 32 },
  );
  const declared = await send(port, {
    headers: { "content-length": 33 },
    chunks: [Buffer.alloc(33, "a")],
  });
  assert.equal(declared.status, 413);
  const chunked = await send(port, {
    chunks: [Buffer.alloc(16, "a"), Buffer.alloc(17, "b")],
  });
  assert.equal(chunked.status, 413);
  assert.equal(upstreamRequests, 0);
});

test("application timeouts return an observable 504 and do not hang the caller", async (t) => {
  const { port } = await setup(
    t,
    (req) => {
      req.resume();
    },
    { deadlineMs: 60 },
  );
  const reply = await send(port, { chunks: [Buffer.from("Digits=1")] });
  assert.equal(reply.status, 504);
  assert.equal(reply.body.toString(), "Local service timed out");
});

test("a stalled incoming body returns 504 rather than resetting before the response is flushed", async (t) => {
  let upstreamRequests = 0;
  const { port } = await setup(
    t,
    (_req, res) => {
      upstreamRequests++;
      res.end("unexpected");
    },
    { deadlineMs: 60 },
  );
  const reply = await send(port, {
    headers: { "content-length": 16 },
    chunks: [Buffer.from("a")],
    leaveBodyOpen: true,
  });
  assert.equal(reply.status, 504);
  assert.equal(reply.body.toString(), "Local service timed out");
  assert.equal(upstreamRequests, 0);
});

test("an unavailable local application returns 502 without exposing connection details", async (t) => {
  const placeholder = createServer();
  const upstreamPort = await listen(placeholder);
  await close(placeholder);
  const relay = createVoiceRelay({ upstreamPort });
  const port = await listen(relay);
  t.after(() => close(relay));
  const reply = await send(port);
  assert.equal(reply.status, 502);
  assert.equal(reply.body.toString(), "Local service unavailable");
});

test("local redirects and oversized responses are rejected without forwarding private headers", async (t) => {
  let requests = 0;
  const { port } = await setup(t, (req, res) => {
    req.resume();
    requests++;
    if (requests === 1) {
      res.writeHead(307, {
        location: "http://127.0.0.1/private",
        "set-cookie": "local-test-cookie=unused",
      });
      res.end("private redirect");
    } else {
      res.writeHead(200, {
        "content-type": "text/xml",
        "set-cookie": "local-test-cookie=unused",
      });
      res.end(Buffer.alloc(131_073, "a"));
    }
  });
  const redirect = await send(port);
  assert.equal(redirect.status, 502);
  assert.equal(redirect.body.toString(), "Unexpected local redirect");
  assert.equal(redirect.headers.location, undefined);
  assert.equal(redirect.headers["set-cookie"], undefined);
  const oversize = await send(port);
  assert.equal(oversize.status, 502);
  assert.equal(oversize.headers["set-cookie"], undefined);
  assert.ok(oversize.body.length < 1_000);
});

test("relay construction rejects invalid local upstream ports", () => {
  for (const upstreamPort of [0, -1, 65536, 3.5, NaN])
    assert.throws(() => createVoiceRelay({ upstreamPort }));
});
