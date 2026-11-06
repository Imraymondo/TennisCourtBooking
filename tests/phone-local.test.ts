import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/phone-local.mjs");
const fakeSettings = {
  TWILIO_AUTH_TOKEN: "test-only-twilio-secret-do-not-display",
  TWILIO_PHONE_NUMBER: "+61400000123",
  NGROK_AUTHTOKEN: "test-only-ngrok-secret-do-not-display",
  PHONE_WEB_PORT: "3000",
  NGROK_DOMAIN: "",
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
        if (specifier.includes("@ngrok/ngrok")) blocked();
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

function assertPrivate(output: string, values = Object.values(fakeSettings)) {
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
  assertPrivate(result.output);
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
  assert.ok(unknown.output.includes("only optional command argument"));
  assertPrivate(unknown.output);
});
