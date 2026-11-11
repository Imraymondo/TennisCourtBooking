import { loadEnvConfig } from "@next/env";
import {
  bookingAIEnabled,
  interpretBookingText,
} from "../lib/channels/booking-ai";

Object.assign(process.env, { NODE_ENV: "development" });
loadEnvConfig(process.cwd(), true);

async function main() {
  if (process.env.VOICE_MODE === "realtime")
    console.log(
      "This check only validates Responses API booking text understanding. It does not validate Realtime model access or a live audio call; see docs/realtime-phone.md.",
    );
  if (!bookingAIEnabled()) {
    console.error(
      "Set BOOKING_AI_ENABLED=1 and OPENAI_API_KEY in your computer's .env.local before checking GPT.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Checking GPT with one short booking-query request. This uses your OpenAI API quota and does not create a booking.",
    );
    const result = await interpretBookingText("请查询明天一号球场的空闲时间", {
      channel: "phone",
      step: "menu",
    });
    if (
      result?.scope === "booking" &&
      result.action === "query" &&
      result.date
    ) {
      console.log(
        "GPT API check passed: a valid booking-query interpretation was received. Restart your local service to use its current settings.",
      );
    } else {
      console.error(
        "GPT API check failed. Check your project key, API billing, model access and network connection in your own OpenAI account. No booking was created; no key or provider error body was printed.",
      );
      process.exitCode = 1;
    }
  }
}

void main().catch(() => {
  console.error(
    "GPT API check failed. Check your local configuration; no key or provider response was printed.",
  );
  process.exitCode = 1;
});
