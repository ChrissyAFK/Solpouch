// Split text nodes keep Cloudflare's email obfuscation from rewriting the
// server HTML, which made React's hydration fail on pages showing the address.
export function ContactEmail() {
  const user = "hello";
  const domain = "solpouch.tech";
  return (
    <a href={`mailto:${user}@${domain}`}>
      {user}
      {"@"}
      {domain}
    </a>
  );
}
