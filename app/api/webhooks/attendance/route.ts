import { handleAttendanceWebhook } from "@/lib/channels/attendance";
import {
  ATTENDANCE_VERSION,
  logAttendanceCallback,
} from "@/lib/channels/attendance-diagnostics";
import {
  verifiedTwilioCallbackForm,
  webhookFailure,
} from "@/lib/channels/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioCallbackForm(request);
    const query = new URL(request.url).searchParams;
    const xml = handleAttendanceWebhook(form, query);
    logAttendanceCallback(form, {
      turn: query.get("turn"),
      event: query.get("event"),
      responseXml: xml,
    });
    return new Response(xml, {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-attendance-version": ATTENDANCE_VERSION,
      },
    });
  } catch (error) {
    const response = webhookFailure(error);
    response.headers.set("x-attendance-version", ATTENDANCE_VERSION);
    return response;
  }
}
