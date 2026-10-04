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
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://accounts.google.com/gsi/client${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    // React, chart sizing and progress bars use inline styles.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    // Google Identity Services sign-in. ElevenLabs agent (chat widget): session setup over HTTPS, conversation over WSS.
    `connect-src 'self' ${backend.origin} https://api.elevenlabs.io wss://api.elevenlabs.io https://accounts.google.com/gsi/ https://auth.privy.io https://*.rpc.privy.systems https://api.devnet.solana.com wss://api.devnet.solana.com${development ? " ws: wss:" : ""}`,
    // Google profile pictures.
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src https://accounts.google.com/gsi/ https://auth.privy.io",
    "child-src https://auth.privy.io",
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
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];
