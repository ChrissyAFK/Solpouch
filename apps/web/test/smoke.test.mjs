// Run against a production preview with default (private) indexing settings.
import assert from "node:assert/strict";
import { test } from "node:test";

const origin = process.env.WEB_TEST_URL ?? "http://localhost:3001";
const get = (path, init) =>
  fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(10000) });

for (const [path, title, status] of [
  ["/", "Spending with limits", 200],
  ["/dashboard", "Overview", 200],
  ["/funding", "Wallet funding", 200],
  ["/order", "New order", 200],
  ["/pouches/groceries", "Pouch details", 200],
  ["/missing-smoke-page", "Page not found", 404],
]) {
  test(`${path}: metadata, private indexing, security headers and nonces`, async () => {
    const response = await get(path);
    const html = await response.text();
    assert.equal(response.status, status);
    assert.ok(html.includes(`<title>${title} | Solpouch</title>`));
    for (const attribute of [
      'name="description"',
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'name="twitter:card"',
    ])
      assert.ok(html.includes(attribute), attribute);
    assert.match(html, /name="robots" content="noindex/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const csp = response.headers.get("content-security-policy");
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.doesNotMatch(
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("script-src ")),
      /unsafe-inline|unsafe-eval/,
    );
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
    assert.ok(scripts.length > 0);
    for (const [script] of scripts)
      assert.ok(
        script.includes(`nonce="${nonce}"`),
        "script nonce must match CSP",
      );
  });
}

test("each HTML response gets a fresh nonce; HTTPS includes HSTS", async () => {
  const responses = await Promise.all([get("/"), get("/")]);
  assert.notEqual(
    responses[0].headers.get("content-security-policy"),
    responses[1].headers.get("content-security-policy"),
  );
  const secure = await get("/", { headers: { "x-forwarded-proto": "https" } });
  assert.match(secure.headers.get("strict-transport-security"), /max-age=/);
  assert.match(
    secure.headers.get("content-security-policy"),
    /upgrade-insecure-requests/,
  );
});

test("manifest, icons, social image and private crawler files are served", async () => {
  const manifestResponse = await get("/manifest.webmanifest");
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "Solpouch");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const path of [
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
    "/social-preview.png",
    ...manifest.icons.map((icon) => icon.src),
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /image\//);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.match(await (await get("/robots.txt")).text(), /Disallow: \//);
  const sitemap = await (await get("/sitemap.xml")).text();
  assert.match(sitemap, /<urlset/);
  assert.doesNotMatch(sitemap, /<loc>/);
});
