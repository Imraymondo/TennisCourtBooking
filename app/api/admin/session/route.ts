import { ensureAdminConfigured, isAdmin } from "@/lib/auth";
import { apiError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const configured = ensureAdminConfigured();
    return json({
      authenticated: isAdmin(request),
      configured,
      development: process.env.NODE_ENV !== "production",
    });
  } catch (error) {
    return apiError(error);
  }
}
