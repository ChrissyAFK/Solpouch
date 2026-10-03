/** Build a policy from trusted server configuration, never request-provided origins. */
export function contentSecurityPolicy({
  nonce,
  development,
  backendUrl,
  secure,
}) {
  const backend = new URL(backendUrl);
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    backend.username ||
    backend.password
  ) {
    throw new Error(
      "NEXT_PUBLIC_BACKEND_URL must be an HTTP(S) URL without credentials.",
    );
  }
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    // React, chart sizing and progress bars use inline styles.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${backend.origin}${development ? " ws: wss:" : ""}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];
