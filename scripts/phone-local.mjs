import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { createVoiceRelay } from "./voice-relay.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.NODE_ENV = "development";
nextEnv.loadEnvConfig(root, true);

const enableSms = process.argv.includes("--sms");
const aiSetting = process.env.BOOKING_AI_ENABLED || "0";
const bookingAiEnabled = aiSetting === "1";
const bookingAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const voiceMode = process.env.VOICE_MODE || "gather";
const realtimeEnabled = voiceMode === "realtime";
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
const realtimeVoice = process.env.OPENAI_REALTIME_VOICE || "marin";
const transcriptionModel =
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-transcribe";
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
if (!["0", "1"].includes(aiSetting))
  errors.push("BOOKING_AI_ENABLED must be 0 or 1.");
if (!["gather", "realtime"].includes(voiceMode))
  errors.push("VOICE_MODE must be gather or realtime.");
if (bookingAiEnabled && !process.env.OPENAI_API_KEY?.trim())
  errors.push(
    "Missing OPENAI_API_KEY: add it to your computer's .env.local when BOOKING_AI_ENABLED is 1.",
  );
if (realtimeEnabled && !process.env.OPENAI_API_KEY?.trim())
  errors.push(
    "Missing OPENAI_API_KEY: add it to your computer's .env.local when VOICE_MODE is realtime.",
  );
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(bookingAiModel))
  errors.push(
    "OPENAI_MODEL must be a valid model identifier using safe characters only.",
  );
for (const [name, value] of [
  ["OPENAI_REALTIME_MODEL", realtimeModel],
  ["OPENAI_REALTIME_TRANSCRIBE_MODEL", transcriptionModel],
]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value))
    errors.push(
      `${name} must be a valid model identifier using safe characters only.`,
    );
}
if (
  ![
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
  ].includes(realtimeVoice)
)
  errors.push(
    "OPENAI_REALTIME_VOICE must be a supported built-in Realtime voice.",
  );
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
    .some((argument) => !["--check", "--diagnose", "--sms"].includes(argument))
)
  errors.push("Supported command arguments are --check, --diagnose and --sms.");
if (errors.length) {
  for (const error of errors) console.error(error);
  console.error("See docs/local-phone.md. Never paste credentials into chat.");
  process.exit(1);
}
const bookingLanguageStatus = bookingAiEnabled
  ? `Booking language: GPT (model ${bookingAiModel})`
  : "Booking language: rule-based";
const voiceModeStatus = realtimeEnabled
  ? `Voice mode: OpenAI Realtime (model ${realtimeModel})`
  : "Voice mode: Twilio Gather";
const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
const phoneBookingSmsStatus = /^AC[0-9a-fA-F]{32}$/.test(accountSid)
  ? "Phone booking SMS: configured"
  : accountSid
    ? "Phone booking SMS: not configured (TWILIO_ACCOUNT_SID must be AC followed by 32 hexadecimal characters)."
    : "Phone booking SMS: not configured (TWILIO_ACCOUNT_SID is missing).";
const attendanceCallStatus = /^AC[0-9a-fA-F]{32}$/.test(accountSid)
  ? "Attendance calls: configured (public callback URL is set when the local tunnel starts)."
  : accountSid
    ? "Attendance calls: not configured (TWILIO_ACCOUNT_SID must be AC followed by 32 hexadecimal characters)."
    : "Attendance calls: not configured (TWILIO_ACCOUNT_SID is missing; add it to .env.local and restart).";
if (process.argv.includes("--check")) {
  console.log(
    "Required local settings are present; no credential values were displayed.",
  );
  console.log(
    "This check does not connect to ngrok, verify provider accounts, or place a call.",
  );
  console.log(bookingLanguageStatus);
  console.log(voiceModeStatus);
  console.log(phoneBookingSmsStatus);
  console.log(attendanceCallStatus);
  if (enableSms)
    console.log(
      "SMS callback forwarding requested; verify SMS capability in the Twilio console before testing.",
    );
  process.exit(0);
}

let relay;
let listener;
let app;
let realtimeBridge;
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
  if (realtimeBridge) {
    try {
      await Promise.race([realtimeBridge.close(), delay(2_000)]);
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
  relay = createVoiceRelay({
    upstreamPort: webPort,
    allowSms: enableSms,
    ...(realtimeEnabled
      ? {
          realtimeUpgrade: (request, socket, head) => {
            if (realtimeBridge)
              realtimeBridge.handleUpgrade(request, socket, head);
            else
              socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          },
        }
      : {}),
  });
  await new Promise((done, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", done);
  });
  const relayPort = relay.address().port;
  const ngrok = (await import("@ngrok/ngrok")).default;
  console.log(
    enableSms
      ? "Opening a temporary HTTPS endpoint for voice, attendance and SMS webhooks only..."
      : "Opening a temporary HTTPS endpoint for voice and attendance webhooks only...",
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
    const bridgeSecret = realtimeEnabled
      ? randomBytes(32).toString("base64url")
      : "";
    if (realtimeEnabled) {
      const { createRealtimeBridge } = await import("./realtime-bridge.mjs");
      realtimeBridge = createRealtimeBridge({
        appUrl: `http://127.0.0.1:${webPort}`,
        publicOrigin: external.origin,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        bridgeSecret,
        apiKey: process.env.OPENAI_API_KEY,
        model: realtimeModel,
        voice: realtimeVoice,
        transcriptionModel,
        diagnostics:
          process.argv.includes("--diagnose") ||
          process.env.VOICE_DEBUG === "1",
      });
    }
    const childEnvironment = {
      ...process.env,
      NODE_ENV: "development",
      VOICE_DEBUG: process.argv.includes("--diagnose")
        ? "1"
        : process.env.VOICE_DEBUG || "0",
      APP_BASE_URL: external.origin,
      VOICE_MODE: voiceMode,
      OPENAI_REALTIME_MODEL: realtimeModel,
      OPENAI_REALTIME_VOICE: realtimeVoice,
      OPENAI_REALTIME_TRANSCRIBE_MODEL: transcriptionModel,
      REALTIME_BRIDGE_SECRET: bridgeSecret,
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
      // Compile each enabled route before the first real callback. Unsigned
      // probes must be denied without creating bookings or contacting providers.
      for (const channel of enableSms
        ? ["voice", "attendance", "sms"]
        : ["voice", "attendance"]) {
        const warm = await fetch(
          `http://127.0.0.1:${webPort}/api/webhooks/${channel}`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "",
            signal: AbortSignal.timeout(15_000),
          },
        );
        await warm.arrayBuffer();
        if (warm.status !== 403)
          throw new Error("Webhook signature validation is not ready");
      }
      if (realtimeEnabled) {
        // Compile the private engine route before the first Media Stream starts.
        // An unauthenticated probe cannot create a session or contact OpenAI.
        const warm = await fetch(
          `http://127.0.0.1:${webPort}/api/realtime/turn`,
          { method: "POST", signal: AbortSignal.timeout(15_000) },
        );
        await warm.arrayBuffer();
        if (warm.status !== 403)
          throw new Error("Realtime bridge authentication is not ready");
      }
      console.log(`Local website: http://127.0.0.1:${webPort}`);
      console.log(bookingLanguageStatus);
      console.log(voiceModeStatus);
      console.log(phoneBookingSmsStatus);
      console.log(attendanceCallStatus);
      if (childEnvironment.VOICE_DEBUG === "1")
        console.log(
          realtimeEnabled
            ? "Realtime diagnostics enabled: routing and step metadata only; audio, speech text and contact details are never printed."
            : "Voice diagnostics enabled: callback metadata only; speech text and contact details are never printed.",
        );
      console.log(
        `Twilio Voice webhook (POST): ${external.origin}/api/webhooks/voice`,
      );
      console.log(
        `Attendance callback (POST; configured automatically): ${external.origin}/api/webhooks/attendance`,
      );
      if (realtimeEnabled)
        console.log(
          `Realtime audio stream: ${external.origin.replace(/^https:/, "wss:")}/api/realtime/voice`,
        );
      if (enableSms)
        console.log(
          `Twilio Messaging webhook (POST): ${external.origin}/api/webhooks/sms`,
        );
      console.log(
        `Only signed ${enableSms ? "voice, attendance and SMS" : "voice and attendance"} webhook requests${realtimeEnabled ? " and the authenticated Realtime audio stream" : ""} are forwarded. The public endpoint does not expose the website, staff pages or internal booking API.`,
      );
      console.log(
        "Set the Voice URL under the Twilio number's Voice > A CALL COMES IN > Webhook > HTTP POST, then call your Twilio number.",
      );
      if (enableSms)
        console.log(
          "Set the Messaging URL under Messaging > A MESSAGE COMES IN > Webhook > HTTP POST. Send HELP from your phone first. See docs/local-sms.md.",
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
