import { handleTextMessage } from "@/lib/channels/text-assistant";
import {
  escapeXml,
  verifiedTwilioForm,
  webhookFailure,
  xmlResponse,
} from "@/lib/channels/security";
import { AppError } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioForm(request);
    const messageId = form.get("MessageSid");
    if (!messageId || !/^[A-Za-z0-9]{10,64}$/.test(messageId))
      throw new AppError("缺少短信事件编号", 400);
    const reply = await handleTextMessage(
      form.get("Body") || "",
      {
        channel: "sms",
        phone: form.get("From")!,
      },
      `sms:${messageId}`,
    );
    return xmlResponse(`<Message>${escapeXml(reply)}</Message>`);
  } catch (error) {
    return webhookFailure(error);
  }
}
