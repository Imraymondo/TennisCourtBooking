import nextEnv from "@next/env";
import { fileURLToPath } from "node:url";
import { Agent } from "node:https";
import WebSocket from "ws";

process.env.NODE_ENV = "development";
nextEnv.loadEnvConfig(fileURLToPath(new URL("../", import.meta.url)), true);

const key = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
const voice = process.env.OPENAI_REALTIME_VOICE || "marin";
const transcription =
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-transcribe";
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

if (
  !key ||
  ![model, voice, transcription].every((value) => safeId.test(value))
) {
  console.error(
    "Configure OPENAI_API_KEY and valid OPENAI_REALTIME_MODEL/VOICE/TRANSCRIBE_MODEL settings in your computer's .env.local.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `Checking OpenAI Realtime audio session (model ${model}). This may use API quota; no caller audio is sent and no booking is created.`,
  );
  const agent = new Agent({ proxyEnv: process.env, keepAlive: false });
  let socket,
    finished = false;
  const finish = (success, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    console[success ? "log" : "error"](
      success
        ? "Realtime API check passed: the server accepted the audio session. Verify actual phone audio with a test call."
        : `Realtime API check failed${code ? ` (${code})` : ""}. Check API billing, Realtime model access and network settings. No key or provider response was printed.`,
    );
    process.exitCode = success ? 0 : 1;
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000);
    else socket?.terminate();
    const force = setTimeout(() => socket?.terminate(), 250);
    force.unref?.();
    agent.destroy();
  };
  const timer = setTimeout(() => finish(false, "timeout"), 15_000);
  try {
    socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        agent,
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
        maxPayload: 65_536,
      },
    );
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model,
            output_modalities: ["audio"],
            instructions:
              "Do not generate a response. This is a connectivity check only.",
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                transcription: { model: transcription, language: "en" },
                turn_detection: {
                  type: "server_vad",
                  create_response: false,
                  interrupt_response: false,
                },
              },
              output: { format: { type: "audio/pcmu" }, voice },
            },
            tool_choice: "none",
            tools: [],
            tracing: null,
          },
        }),
      ),
    );
    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        finish(false, "invalid_event");
        return;
      }
      if (event.type === "session.updated") finish(true);
      else if (event.type === "error") finish(false, "session_rejected");
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(false, `HTTP ${Number(response.statusCode) || 0}`);
    });
    socket.on("error", () => finish(false, "connection"));
    socket.on("close", () => {
      if (!finished) finish(false, "connection_closed");
    });
  } catch {
    finish(false, "configuration");
  }
}
