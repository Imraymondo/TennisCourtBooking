import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/check-openai.ts");
const fakeKey = "test-only-ai-check-key-do-not-display";

function check(enabled: string, key: string, accepted = true) {
  const result = {
    scope: "booking",
    action: "query",
    date: "2099-12-01",
    court: 1,
    hour: null,
    duration: null,
    name: null,
    correction: null,
  };
  const source = `
    import https from 'node:https';
    import net from 'node:net';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    let calls = 0;
    let unexpected = false;
    const blocked = () => { unexpected = true; throw new Error('Unexpected network'); };
    net.Socket.prototype.connect = blocked;
    net.Server.prototype.listen = blocked;
    globalThis.fetch = blocked;
    https.request = (url, options, callback) => {
      if (url !== 'https://api.openai.com/v1/responses') blocked();
      calls++;
      const request = new EventEmitter();
      request.end = body => {
        const payload = JSON.parse(body);
        if (payload.store !== false || payload.model !== 'gpt-4.1-mini' || payload.tools) blocked();
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = ${accepted ? 200 : 401};
          response.destroy = () => {};
          callback(response);
          response.emit('data', Buffer.from(JSON.stringify({
            status:'completed', output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(${JSON.stringify(result)})}]}]
          })));
          response.emit('end');
        });
      };
      return request;
    };
    syncBuiltinESMExports();
    process.once('exit', () => {
      if (unexpected || calls !== ${enabled === "1" && key ? 1 : 0}) process.exitCode = 88;
    });
    await import(pathToFileURL(${JSON.stringify(script)}).href);
  `;
  const output = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOKING_AI_ENABLED: enabled,
        OPENAI_API_KEY: key,
        OPENAI_MODEL: "gpt-4.1-mini",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(output.error);
  assert.equal(output.signal, null);
  assert.notEqual(
    output.status,
    88,
    "the check must use one mocked request only when explicitly enabled",
  );
  const text = output.stdout + output.stderr;
  assert.ok(
    !text.includes(fakeKey),
    "API keys must never appear in check output",
  );
  return { status: output.status, text };
}

test("API check explains missing configuration without opening a connection", () => {
  for (const [enabled, key] of [
    ["0", fakeKey],
    ["1", ""],
  ]) {
    const result = check(enabled, key);
    assert.equal(result.status, 1);
    assert.match(result.text, /BOOKING_AI_ENABLED=1 and OPENAI_API_KEY/);
  }
});

test("API check validates one harmless booking interpretation without touching booking storage", () => {
  const result = check("1", fakeKey);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /GPT API check passed/);
  assert.match(result.text, /does not create a booking/);
});

test("API check reports failure without revealing a provider response or credential", () => {
  const result = check("1", fakeKey, false);
  assert.equal(result.status, 1);
  assert.match(result.text, /GPT API check failed/);
});
