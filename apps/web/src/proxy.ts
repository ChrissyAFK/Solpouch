import { NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "../security.mjs";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const secure = request.nextUrl.protocol === "https:";
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787",
    secure,
  });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  // A cached HTML response would reuse its one-time script nonce.
  response.headers.set("Cache-Control", "private, no-store");
  if (secure) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static/|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|icons/|social-preview\\.png$|robots\\.txt$|sitemap\\.xml$|manifest\\.webmanifest$|sw\\.js$|\\.well-known/).*)",
  ],
};
