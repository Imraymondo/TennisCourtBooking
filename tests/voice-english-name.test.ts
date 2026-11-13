import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { BookingInterpretation } from "../lib/channels/booking-ai";
import { handleVoice, voiceProgress } from "../lib/channels/voice";
import { closeDatabase, getChannelState, listBookings } from "../lib/store";

beforeEach(() => {
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
});
after(closeDatabase);

for (const name of ["June First", "John Noon"]) {
  test(`the interpreted booking name ${name} preserves the pending schedule`, () => {
    const sid = `CA${randomUUID().replaceAll("-", "")}`;
    const send = (
      speech = "",
      interpretation: BookingInterpretation | null = null,
    ) =>
      handleVoice(
        sid,
        "+61400123456",
        voiceProgress(sid)?.turn || null,
        "",
        speech,
        interpretation,
      );
    const state = () => JSON.parse(getChannelState(`voice:${sid}`)!);
    send();
    send("Book a court on December 1 2099 at three pm for two hours");
    assert.equal(state().step, "name");
    const reply = send(`My name is ${name}`, {
      scope: "booking",
      action: null,
      date: null,
      court: null,
      hour: null,
      duration: null,
      name,
      correction: null,
    });
    assert.match(reply, /contact number/i);
    assert.equal(state().name, name);
    assert.equal(state().date, "2099-12-01");
    assert.equal(state().hour, "15");
    assert.equal(state().duration, 2);
    assert.equal(state().step, "contact");
    assert.equal(listBookings().length, 0);
  });
}
