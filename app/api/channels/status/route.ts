import { twilioConfigured } from "@/lib/channels/security";
import { emailConfigured } from "@/lib/channels/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const telephone = twilioConfigured();
  const email = emailConfigured();
  return Response.json(
    {
      phone: telephone,
      sms: telephone,
      email,
      ...(telephone ? { phoneNumber: process.env.TWILIO_PHONE_NUMBER } : {}),
      ...(email ? { emailAddress: process.env.POSTMARK_INBOUND_EMAIL } : {}),
      configurationOnly: true,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
