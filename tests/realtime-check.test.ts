import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const fakeKey = "test-only-realtime-api-key-never-print";
const script = resolve("scripts/check-realtime.mjs");

function run(key = fakeKey, mode = "accepted", model = "gpt-realtime-1.5") {
  const mockWebSocket = `
    import { EventEmitter } from 'node:events';
    export default class MockWebSocket extends EventEmitter {
      static OPEN = 1;
      constructor(url, options) {
        super(); this.readyState = 1;
        if (!url.startsWith('wss://api.openai.com/v1/realtime?model=') || options.headers.Authorization !== 'Bearer ${fakeKey}') throw new Error('Unexpected endpoint or credential');
        queueMicrotask(() => this.emit('open'));
      }
      send(raw) {
        const data = JSON.parse(raw);
        const s = data.session;
        if (data.type !== 'session.update' || s.type !== 'realtime' || s.audio.input.format.type !== 'audio/pcmu' || s.audio.output.format.type !== 'audio/pcmu' || s.audio.input.turn_detection.create_response !== false || s.tools.length) throw new Error('Unexpected audio-session request');
        queueMicrotask(() => {
          ${mode === "http_error" ? "this.emit('unexpected-response', {}, {statusCode:401,resume(){}});" : mode === "rejected" ? `this.emit('message', Buffer.from(JSON.stringify({type:'error',error:{message:'${fakeKey}'}})));` : "this.emit('message', Buffer.from(JSON.stringify({type:'session.updated'})));"}
        });
      }
      close() { this.readyState = 3; this.emit('close'); }
      terminate() { this.close(); }
    }
  `;
  const source = `
    import { registerHooks } from 'node:module';
    import net from 'node:net';
    import { pathToFileURL } from 'node:url';
    const blocked = () => { process.exitCode = 88; throw new Error('Unexpected network'); };
    net.Socket.prototype.connect = blocked;
    net.Server.prototype.listen = blocked;
    globalThis.fetch = blocked;
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'ws') return {url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(mockWebSocket))}, shortCircuit:true};
      return nextResolve(specifier, context);
    }});
    await import(pathToFileURL(${JSON.stringify(script)}).href);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENAI_API_KEY: key,
        OPENAI_REALTIME_MODEL: model,
        OPENAI_REALTIME_VOICE: "marin",
        OPENAI_REALTIME_TRANSCRIBE_MODEL: "gpt-transcribe",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  assert.ok(
    !output.includes(fakeKey),
    "no diagnostic may print an API key or provider error body",
  );
  return { status: result.status, output };
}

test("Realtime check rejects missing or invalid local configuration without networking", () => {
  for (const result of [run(""), run(fakeKey, "accepted", "unsafe\nmodel")]) {
    assert.equal(result.status, 1);
    assert.match(result.output, /Configure OPENAI_API_KEY/);
    assert.ok(!result.output.includes("unsafe"));
  }
});

test("Realtime check confirms an accepted PCMU audio session without streaming caller audio or creating a booking", () => {
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Realtime API check passed/);
  assert.match(
    result.output,
    /no caller audio is sent and no booking is created/,
  );
});

test("Realtime check reports safe authentication and session failures", () => {
  for (const mode of ["http_error", "rejected"]) {
    const result = run(fakeKey, mode);
    assert.equal(result.status, 1);
    assert.match(result.output, /Realtime API check failed/);
  }
  assert.match(run(fakeKey, "http_error").output, /HTTP 401/);
});
