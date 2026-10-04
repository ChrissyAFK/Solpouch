// Checks which audioWorklet.addModule sources load under the production CSP.
import { createServer } from "node:http";
import { contentSecurityPolicy } from "../security.mjs";

// Set PLAYWRIGHT_MODULE to an installed Playwright module path if "playwright" does not resolve.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const nonce = "testnonce123";
const csp = contentSecurityPolicy({ nonce, development: false, secure: false, backendUrl: "http://localhost:4000" });
// A minimal processor stands in for the SDK's bundled worklets.
const worklet = "class P extends AudioWorkletProcessor { process() { return true; } }\nregisterProcessor('p', P);\n";
const page = `<!doctype html><html><body><script nonce="${nonce}">
(async () => {
  const out = {};
  const ctx = new AudioContext();
  const src = await (await fetch("/worklet.js")).text();
  const blobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
  try { await ctx.audioWorklet.addModule(blobUrl); out.blob = "ok"; } catch (e) { out.blob = "blocked: " + e.name; }
  try { await ctx.audioWorklet.addModule("/worklet.js"); out.path = "ok"; } catch (e) { out.path = "blocked: " + e.name; }
  window.__result = out;
})();
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/worklet.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(worklet);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": csp });
  res.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
let code = 1;
try {
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.__result, null, { timeout: 15000 });
  const result = await tab.evaluate(() => window.__result);
  console.log("blob:", result.blob, "| same-origin path:", result.path);
  // The SDK loads its bundled worklets from a blob: URL (no workletPaths are passed), so blob must work.
  code = result.blob === "ok" ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
