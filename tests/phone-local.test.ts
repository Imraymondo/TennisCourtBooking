import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/phone-local.mjs");
const fakeSettings = {
  TWILIO_AUTH_TOKEN: "test-only-twilio-secret-do-not-display",
  TWILIO_PHONE_NUMBER: "+61400000123",
  TWILIO_ACCOUNT_SID: "",
  NGROK_AUTHTOKEN: "test-only-ngrok-secret-do-not-display",
  PHONE_WEB_PORT: "3000",
  NGROK_DOMAIN: "",
  // Explicit empty/off settings override inherited values and local env files.
  BOOKING_AI_ENABLED: "0",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "",
  VOICE_MODE: "gather",
  OPENAI_REALTIME_MODEL: "",
  OPENAI_REALTIME_VOICE: "",
  OPENAI_REALTIME_TRANSCRIBE_MODEL: "",
  REALTIME_BRIDGE_SECRET: "",
};

// The check is deliberately run with fake credentials. Block side effects in the
// child as well, so a future refactor cannot make preflight open a tunnel/server.
function check(
  settings: Partial<typeof fakeSettings> = {},
  args = ["--check"],
  simulatedNodeVersion?: string,
) {
  const source = `
    import net from "node:net";
    import childProcess from "node:child_process";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const blocked = () => { throw new Error("PREFLIGHT_SIDE_EFFECT_ATTEMPTED"); };
    net.Server.prototype.listen = blocked;
    net.Socket.prototype.connect = blocked;
    childProcess.spawn = blocked;
    globalThis.fetch = blocked;
    syncBuiltinESMExports();
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.includes("@ngrok/ngrok") || specifier.includes("realtime-bridge.mjs")) blocked();
        return nextResolve(specifier, context);
      }
    });
    ${simulatedNodeVersion ? `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(simulatedNodeVersion)} });` : ""}
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
    await import(pathToFileURL(${JSON.stringify(script)}).href);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...fakeSettings,
        ...settings,
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 100_000,
    },
  );
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes("PREFLIGHT_SIDE_EFFECT_ATTEMPTED"), output);
  assert.equal(result.signal, null);
  return { status: result.status, output };
}

function assertPrivate(
  output: string,
  values = Object.entries(fakeSettings)
    .filter(([name]) => !["BOOKING_AI_ENABLED", "VOICE_MODE"].includes(name))
    .map(([, value]) => value),
) {
  for (const value of values.filter(Boolean)) {
    assert.ok(
      !output.includes(value),
      "preflight must not print configured values",
    );
  }
  assert.ok(
    !/\b(?:https?|wss?):\/\//i.test(output),
    "preflight must not print a URL",
  );
}

test("missing local credentials are named without starting servers or loading ngrok", () => {
  // Empty process values take precedence over any .env.local provider bindings.
  const result = check({
    TWILIO_AUTH_TOKEN: "",
    TWILIO_PHONE_NUMBER: "",
    NGROK_AUTHTOKEN: "",
    PHONE_WEB_PORT: "",
    NGROK_DOMAIN: "",
  });
  assert.equal(result.status, 1);
  for (const name of [
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "NGROK_AUTHTOKEN",
  ]) {
    assert.ok(result.output.includes(`Missing ${name}`));
  }
  assertPrivate(result.output);
});

test("valid fake settings pass a non-network check without revealing any values", () => {
  const result = check();
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes("does not connect"));
  assert.ok(result.output.includes("Booking language: rule-based"));
  assert.ok(
    result.output.includes(
      "Voice mode: Twilio Gather (English ASR en-AU; Polly.Olivia-Neural)",
    ),
  );
  assert.ok(
    result.output.includes(
      "Phone booking SMS: not configured (TWILIO_ACCOUNT_SID is missing).",
    ),
  );
  assert.ok(
    result.output.includes(
      "Attendance calls: not configured (TWILIO_ACCOUNT_SID is missing; add it to .env.local and restart).",
    ),
  );
  assertPrivate(result.output);
});

test("phone booking SMS and attendance calls are optional and preflight never reveals or uses the account SID", () => {
  const sid = `AC${"a1".repeat(16)}`;
  const configured = check({ TWILIO_ACCOUNT_SID: sid });
  assert.equal(configured.status, 0, configured.output);
  assert.ok(configured.output.includes("Phone booking SMS: configured"));
  assert.ok(configured.output.includes("Attendance calls: configured"));
  assert.ok(
    configured.output.includes(
      "public callback URL is set when the local tunnel starts",
    ),
  );
  assertPrivate(configured.output, [...Object.values(fakeSettings), sid]);

  for (const invalid of [
    "private-invalid-account-sid",
    "ACshort",
    `${sid}\n`,
  ]) {
    const result = check({ TWILIO_ACCOUNT_SID: invalid });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      result.output.includes(
        "Phone booking SMS: not configured (TWILIO_ACCOUNT_SID must be AC followed by 32 hexadecimal characters).",
      ),
    );
    assert.ok(
      result.output.includes(
        "Attendance calls: not configured (TWILIO_ACCOUNT_SID must be AC followed by 32 hexadecimal characters).",
      ),
    );
    assertPrivate(result.output, [...Object.values(fakeSettings), invalid]);
  }
});

test("empty/off AI test settings override inherited environment values without exposing them", () => {
  const names = [
    "BOOKING_AI_ENABLED",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "VOICE_MODE",
    "OPENAI_REALTIME_MODEL",
    "OPENAI_REALTIME_VOICE",
    "OPENAI_REALTIME_TRANSCRIBE_MODEL",
    "REALTIME_BRIDGE_SECRET",
    "TWILIO_ACCOUNT_SID",
  ] as const;
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const inheritedKey = "test-only-inherited-openai-secret-do-not-display";
  try {
    process.env.BOOKING_AI_ENABLED = "1";
    process.env.OPENAI_API_KEY = inheritedKey;
    process.env.OPENAI_MODEL = "inherited-private-model-do-not-display";
    process.env.VOICE_MODE = "realtime";
    process.env.OPENAI_REALTIME_MODEL = "private-inherited-realtime-model";
    process.env.OPENAI_REALTIME_VOICE = "private-inherited-realtime-voice";
    process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL =
      "private-inherited-transcriber";
    process.env.REALTIME_BRIDGE_SECRET = "private-inherited-bridge-secret";
    process.env.TWILIO_ACCOUNT_SID = `AC${"b2".repeat(16)}`;
    const result = check();
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes("Booking language: rule-based"));
    assert.ok(
      result.output.includes(
        "Voice mode: Twilio Gather (English ASR en-AU; Polly.Olivia-Neural)",
      ),
    );
    assert.ok(result.output.includes("TWILIO_ACCOUNT_SID is missing"));
    assertPrivate(
      result.output,
      names
        .filter((name) => name !== "BOOKING_AI_ENABLED")
        .map((name) => process.env[name] || ""),
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("Realtime requires a nonblank key independently of the optional text AI setting", () => {
  for (const key of ["", "   "]) {
    const result = check({
      VOICE_MODE: "realtime",
      BOOKING_AI_ENABLED: "0",
      OPENAI_API_KEY: key,
    });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("Missing OPENAI_API_KEY"));
    assert.ok(result.output.includes("VOICE_MODE is realtime"));
    assertPrivate(result.output);
  }
});

test("Realtime preflight safely reports its model without importing its bridge or opening connections", () => {
  const key = "test-only-realtime-key-do-not-display";
  const bridgeSecret = "test-only-existing-bridge-secret-do-not-display";
  for (const model of ["", "gpt-realtime-1.5"]) {
    const result = check(
      {
        VOICE_MODE: "realtime",
        OPENAI_API_KEY: key,
        OPENAI_REALTIME_MODEL: model,
        REALTIME_BRIDGE_SECRET: bridgeSecret,
      },
      ["--check", "--diagnose", "--sms"],
    );
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes("does not connect"));
    assert.ok(result.output.includes("Booking language: rule-based"));
    assert.ok(
      result.output.includes(
        `Voice mode: OpenAI Realtime (model ${model || "gpt-realtime-1.5"}; English transcription en)`,
      ),
    );
    assertPrivate(result.output, [
      key,
      bridgeSecret,
      fakeSettings.TWILIO_AUTH_TOKEN,
      fakeSettings.NGROK_AUTHTOKEN,
    ]);
  }
});

test("Realtime voice and transcription defaults or supported overrides pass a local-only check", () => {
  for (const voice of [
    "",
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
  ]) {
    const result = check({
      VOICE_MODE: "realtime",
      OPENAI_API_KEY: "test-only-realtime-key",
      OPENAI_REALTIME_VOICE: voice,
      OPENAI_REALTIME_TRANSCRIBE_MODEL: "gpt-transcribe",
      OPENAI_MODEL: "gpt-4.1-mini",
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      result.output.includes(
        "Voice mode: OpenAI Realtime (model gpt-realtime-1.5; English transcription en)",
      ),
    );
    assertPrivate(result.output);
    assert.ok(!result.output.includes("test-only-realtime-key"));
  }
});

test("voice mode and Realtime configuration reject invalid values without printing them", () => {
  for (const mode of ["REALTIME", "true", "private-invalid-mode\nsecret"]) {
    const result = check({ VOICE_MODE: mode });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("VOICE_MODE must be gather or realtime"));
    assertPrivate(result.output);
    assert.ok(!result.output.includes(mode));
  }
  for (const name of [
    "OPENAI_REALTIME_MODEL",
    "OPENAI_REALTIME_TRANSCRIBE_MODEL",
  ] as const) {
    for (const model of [
      "model with spaces",
      "https://private.example/model",
      "model\nprivate-secret",
      "x".repeat(121),
    ]) {
      const result = check({ [name]: model });
      assert.equal(result.status, 1);
      assert.ok(
        result.output.includes(`${name} must be a valid model identifier`),
      );
      assertPrivate(result.output);
      assert.ok(!result.output.includes(model));
    }
  }
  const voice = "private-invalid-voice\nsecret";
  const result = check({ OPENAI_REALTIME_VOICE: voice });
  assert.equal(result.status, 1);
  assert.ok(
    result.output.includes(
      "OPENAI_REALTIME_VOICE must be a supported built-in Realtime voice",
    ),
  );
  assertPrivate(result.output);
  assert.ok(!result.output.includes(voice));
});

test("GPT enabled without a nonblank API key fails by variable name without network effects", () => {
  for (const key of ["", "   "]) {
    const result = check({ BOOKING_AI_ENABLED: "1", OPENAI_API_KEY: key });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("Missing OPENAI_API_KEY"));
    assertPrivate(result.output);
  }
});

test("GPT preflight reports its safe default or selected model but never the API key", () => {
  const key = "test-only-openai-secret-do-not-display";
  for (const model of ["", "gpt-4.1", "ft:gpt-4.1-mini:example:booking:1"]) {
    const result = check({
      BOOKING_AI_ENABLED: "1",
      OPENAI_API_KEY: key,
      OPENAI_MODEL: model,
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      result.output.includes(
        `Booking language: GPT (model ${model || "gpt-4.1-mini"})`,
      ),
    );
    assertPrivate(result.output, [
      fakeSettings.TWILIO_AUTH_TOKEN,
      fakeSettings.TWILIO_PHONE_NUMBER,
      fakeSettings.NGROK_AUTHTOKEN,
      key,
    ]);
  }
});

test("invalid AI flags and model strings fail with fixed messages and no supplied values", () => {
  for (const flag of ["true", "yes", "2", "private-invalid-ai-flag\nsecret"]) {
    const result = check({ BOOKING_AI_ENABLED: flag });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("BOOKING_AI_ENABLED must be 0 or 1"));
    assertPrivate(result.output);
    assert.ok(!result.output.includes(flag));
  }
  for (const model of [
    "model with spaces",
    "https://private.example/model",
    "model\nprivate-secret",
    "model\u001b[31mprivate-secret",
    "../private",
    "x".repeat(121),
  ]) {
    const result = check({ OPENAI_MODEL: model });
    assert.equal(result.status, 1);
    assert.ok(
      result.output.includes("OPENAI_MODEL must be a valid model identifier"),
    );
    assertPrivate(result.output);
    assert.ok(!result.output.includes(model));
  }
});

test("check takes precedence over diagnose without opening connections or exposing settings", () => {
  const result = check({}, ["--check", "--diagnose"]);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes("does not connect"));
  assertPrivate(result.output);
});

test("SMS opt-in preflight remains non-networking and private with check and diagnose flags", () => {
  for (const args of [
    ["--sms", "--check"],
    ["--check", "--diagnose", "--sms"],
  ]) {
    const result = check({}, args);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes("does not connect"));
    assertPrivate(result.output);
  }
});

test("invalid phone input is rejected without echoing the supplied value", () => {
  const phone = "private-invalid-phone-do-not-display";
  const result = check({ TWILIO_PHONE_NUMBER: phone });
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("TWILIO_PHONE_NUMBER"));
  assertPrivate(result.output, [...Object.values(fakeSettings), phone]);
});

test("invalid ports and tunnel-domain syntax fail safely before any connection", () => {
  for (const port of ["0", "65536", "3000.5", "private-invalid-port"]) {
    const result = check({ PHONE_WEB_PORT: port });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("PHONE_WEB_PORT"));
    assertPrivate(result.output);
  }
  for (const domain of [
    "https://private.example",
    "private.example/path",
    "-private.example",
    "private..example",
    "private.-label.example",
  ]) {
    const result = check({ NGROK_DOMAIN: domain });
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("NGROK_DOMAIN"));
    assertPrivate(result.output, [...Object.values(fakeSettings), domain]);
  }
});

test("an optional hostname and supported boundary ports require no live provider access", () => {
  for (const port of ["1", "65535"]) {
    const domain = "test-only-tenant.ngrok-free.app";
    const result = check({ PHONE_WEB_PORT: port, NGROK_DOMAIN: domain });
    assert.equal(result.status, 0, result.output);
    assertPrivate(result.output, [...Object.values(fakeSettings), domain]);
  }
});

test("unsupported Node versions and unknown flags stop without showing settings", () => {
  const oldNode = check({}, ["--check"], "24.4.0");
  assert.equal(oldNode.status, 1);
  assert.ok(oldNode.output.includes("Node.js 24.5+"));
  assertPrivate(oldNode.output);
  const unknown = check({}, ["--check", "--unknown"]);
  assert.equal(unknown.status, 1);
  assert.ok(unknown.output.includes("Supported command arguments"));
  assertPrivate(unknown.output);
});
