import { logout, sessionCookie } from "@/lib/auth";
import { apiError, ensureSameOrigin, json } from "@/lib/http";

export const runtime = "nodejs";

export function POST(request: Request) {
  try {
    ensureSameOrigin(request);
    logout(request);
    return json({ authenticated: false }, 200, {
      "Set-Cookie": sessionCookie(request, "", true),
    });
  } catch (error) {
    return apiError(error);
  }
}
