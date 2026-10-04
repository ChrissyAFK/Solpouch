// Applies voice/prompt.md, voice/keywords.txt and turn settings to the live ElevenLabs agent.
// Run only when the owner says so: node voice/apply-settings.mjs [--dry-run]
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Minimal .env loader (dotenv is not installed at the repo root). Never overrides real env vars.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: id } = process.env;
if (!key || !id) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set in .env");
const here = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const keywords = here("./keywords.txt").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const promptText = here("./prompt.md");
const url = `https://api.elevenlabs.io/v1/convai/agents/${id}`;
if (process.argv.includes("--dry-run")) {
  console.log(`would GET then PATCH ${url}: ${keywords.length} keywords, speculative_turn=true, turn_eagerness=normal, speed=1.1, prompt ${promptText.length} chars`);
} else {
  // Nested objects may be replaced rather than merged, so start from the agent's current settings.
  const cur = await fetch(url, { headers: { "xi-api-key": key } }).catch((e) => ({ ok: false, status: e.message }));
  if (!cur.ok) {
    console.error(`Aborting: could not read the current agent settings (${cur.status}). Nothing was changed.`);
    process.exit(1);
  }
  const cc = (await cur.json())?.conversation_config ?? {};
  // The API returns both `tools` and `tool_ids` but accepts only one of them back.
  const { tools, ...curPrompt } = cc.agent?.prompt ?? {};
  const toolsBefore = curPrompt.tool_ids?.length ?? tools?.length ?? 0;
  const body = {
    conversation_config: {
      asr: { ...cc.asr, keywords },
      // "patient" left 0.2-0.8 s of dead air after every sentence; speculative_turn starts the LLM before the turn ends.
      turn: { ...cc.turn, speculative_turn: true, turn_eagerness: "normal" },
      // Expressive mode makes the LLM invent bracketed audio tags ("[Understood]") that get spoken and shown.
      tts: { ...cc.tts, expressive_mode: false, speed: 1.1 },
      agent: { prompt: { ...curPrompt, ...(curPrompt.tool_ids ? {} : tools ? { tools } : {}), prompt: promptText } },
    },
  };
  const res = await fetch(url, { method: "PATCH", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 500)}`);
  const c = JSON.parse(text).conversation_config;
  console.log(`applied: ${c?.asr?.keywords?.length ?? "?"} keywords, speculative_turn=${c?.turn?.speculative_turn}, turn_eagerness=${c?.turn?.turn_eagerness}, expressive_mode=${c?.tts?.expressive_mode}, speed=${c?.tts?.speed}, tools ${toolsBefore} -> ${c?.agent?.prompt?.tool_ids?.length ?? c?.agent?.prompt?.tools?.length ?? 0}, prompt ${c?.agent?.prompt?.prompt?.length} chars`);
}
