import { handleAttendanceWebhook } from "@/lib/channels/attendance";
import {
  verifiedTwilioCallbackForm,
  webhookFailure,
} from "@/lib/channels/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioCallbackForm(request);
    const xml = handleAttendanceWebhook(
      form,
      new URL(request.url).searchParams,
    );
    return new Response(xml, {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return webhookFailure(error);
  }
}
