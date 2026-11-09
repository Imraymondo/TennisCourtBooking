import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { createVoiceRelay } from "./voice-relay.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.NODE_ENV = "development";
nextEnv.loadEnvConfig(root, true);

const errors = [];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 5)
  errors.push("Use Node.js 24.5+ within 24.x (.nvmrc pins 24.22.1).");
for (const name of [
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "NGROK_AUTHTOKEN",
]) {
  if (!process.env[name]?.trim())
    errors.push(
      `Missing ${name}: add the existing value to your computer's .env.local.`,
    );
}
if (
  process.env.TWILIO_PHONE_NUMBER &&
  !/^\+\d{7,15}$/.test(process.env.TWILIO_PHONE_NUMBER)
) {
  errors.push(
    "TWILIO_PHONE_NUMBER must be in E.164 format, with country code and no spaces.",
  );
}
const webPort = Number(process.env.PHONE_WEB_PORT || 3000);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  errors.push("PHONE_WEB_PORT must be an integer from 1 to 65535.");
if (
  process.env.NGROK_DOMAIN &&
  !(
    process.env.NGROK_DOMAIN.length <= 253 &&
    process.env.NGROK_DOMAIN.includes(".") &&
    process.env.NGROK_DOMAIN.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )
  )
) {
  errors.push(
    "NGROK_DOMAIN must be a hostname from your ngrok account, without scheme or path.",
  );
}
if (
  process.argv
    .slice(2)
    .some((argument) => !["--check", "--diagnose"].includes(argument))
)
  errors.push("Supported command arguments are --check and --diagnose.");
if (errors.length) {
  for (const error of errors) console.error(error);
  console.error("See docs/local-phone.md. Never paste credentials into chat.");
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log(
    "Required local settings are present; no credential values were displayed.",
  );
  console.log(
    "This check does not connect to ngrok, verify provider accounts, or place a call.",
  );
  process.exit(0);
}

let relay;
let listener;
let app;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (listener) {
    try {
      await Promise.race([listener.close(), delay(2_000)]);
    } catch {
      /* already closed */
    }
  }
  if (relay) {
    relay.close();
    relay.closeAllConnections();
  }
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => app.once("exit", done)),
      delay(3_000),
    ]);
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  }
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop();
  });

try {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(webPort, "127.0.0.1", done);
  });
  await new Promise((done) => probe.close(done));
  relay = createVoiceRelay({ upstreamPort: webPort });
  await new Promise((done, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", done);
  });
  const relayPort = relay.address().port;
  const ngrok = (await import("@ngrok/ngrok")).default;
  console.log(
    "Opening a temporary HTTPS endpoint for the voice webhook only...",
  );
  let openingTimer;
  try {
    listener = await Promise.race([
      ngrok.forward({
        addr: `http://127.0.0.1:${relayPort}`,
        authtoken_from_env: true,
        schemes: ["HTTPS"],
        ...(process.env.NGROK_DOMAIN
          ? { domain: process.env.NGROK_DOMAIN }
          : {}),
      }),
      new Promise((_, reject) => {
        openingTimer = setTimeout(
          () => reject(new Error("Tunnel setup timed out")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(openingTimer);
  }
  const external = new URL(listener.url());
  if (
    external.protocol !== "https:" ||
    external.username ||
    external.password ||
    external.search ||
    external.hash ||
    external.pathname !== "/"
  ) {
    throw new Error("Invalid tunnel origin");
  }
  if (stopping) {
    await listener.close();
  } else {
    const childEnvironment = {
      ...process.env,
      NODE_ENV: "development",
      VOICE_DEBUG: process.argv.includes("--diagnose")
        ? "1"
        : process.env.VOICE_DEBUG || "0",
      APP_BASE_URL: external.origin,
      BOOKING_DB_PATH: resolve(
        root,
        process.env.BOOKING_DB_PATH || ".data/bookings.sqlite",
      ),
    };
    app = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/next/dist/bin/next", import.meta.url),
        ),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: root,
        env: childEnvironment,
        stdio: "inherit",
      },
    );
    let failed = false;
    app.once("error", () => {
      failed = true;
    });
    let ready = false;
    const readinessDeadline = Date.now() + 30_000;
    while (Date.now() < readinessDeadline && !stopping) {
      if (failed || app.exitCode !== null || app.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/api/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        const body = await response.json();
        if (
          response.ok &&
          body.status === "ok" &&
          body.service === "courtside"
        ) {
          ready = true;
          break;
        }
      } catch {
        /* server compiling */
      }
      await delay(200);
    }
    if (!ready && !stopping) throw new Error("Local app not ready");
    if (!stopping) {
      // Compile the voice route before the first real call. An unsigned probe
      // must be denied and never creates a booking or contacts a provider.
      const warm = await fetch(
        `http://127.0.0.1:${webPort}/api/webhooks/voice`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "",
          signal: AbortSignal.timeout(15_000),
        },
      );
      await warm.arrayBuffer();
      if (warm.status !== 403)
        throw new Error("Voice signature validation is not ready");
      console.log(`Local website: http://127.0.0.1:${webPort}`);
      if (childEnvironment.VOICE_DEBUG === "1")
        console.log(
          "Voice diagnostics enabled: callback metadata only; speech text and contact details are never printed.",
        );
      console.log(
        `Twilio Voice webhook (POST): ${external.origin}/api/webhooks/voice`,
      );
      console.log(
        "Only signed voice webhook requests are forwarded. The public endpoint does not expose the website or staff pages.",
      );
      console.log(
        "Set this URL under the Twilio number's Voice > A CALL COMES IN > Webhook > HTTP POST, then call your Twilio number.",
      );
      console.log(
        "Keep this terminal and computer running. Ctrl+C closes the temporary endpoint; bookings stay on your computer.",
      );
      app.once("exit", () => {
        if (!stopping) void stop(1);
      });
    }
  }
} catch (error) {
  const code =
    typeof error?.message === "string"
      ? error.message.match(/ERR_NGROK_\d+/)?.[0]
      : undefined;
  console.error(`Local phone setup failed${code ? ` (${code})` : ""}.`);
  if (error?.code === "EADDRINUSE")
    console.error(
      "Close the previous project dev server, or choose a different PHONE_WEB_PORT.",
    );
  else
    console.error(
      "Check local settings, ngrok account/network access, and whether the website can start. See docs/local-phone.md.",
    );
  // Provider error strings can contain credentials, so never echo the raw error.
  await stop(1);
}
