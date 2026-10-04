// Brings the live ElevenLabs agent's tools in line with voice/tools.json:
// confirm_order gets a `version` argument and prepare_demo_checkout is created and attached.
// Run only when the owner says so: node voice/sync-tools.mjs [--dry-run]
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
const dry = process.argv.includes("--dry-run");
const base = "https://api.elevenlabs.io/v1/convai";
const toolsJson = JSON.parse(readFileSync(fileURLToPath(new URL("./tools.json", import.meta.url)), "utf8"));
const wanted = (Array.isArray(toolsJson) ? toolsJson : toolsJson.tools ?? []).find((t) => t.name === "prepare_demo_checkout");
if (!wanted?.description) throw new Error("voice/tools.json has no prepare_demo_checkout description");

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs ${method} ${path.replace(/\/[^/]*$/, "/...")} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const agent = await call("GET", `/agents/${id}`);
const toolIds = agent?.conversation_config?.agent?.prompt?.tool_ids ?? [];
const byName = new Map();
for (const tid of toolIds) {
  const t = await call("GET", `/tools/${tid}`);
  if (t?.tool_config?.name) byName.set(t.tool_config.name, { id: tid, config: t.tool_config });
}
const confirm = byName.get("confirm_order");
if (!confirm) throw new Error("The live agent has no confirm_order tool to clone from.");

const actions = [];
const schema = confirm.config.api_schema.request_body_schema;
if (!schema.properties?.version) {
  const orderIdProp = schema.properties.orderId;
  const next = structuredClone(confirm.config);
  const ns = next.api_schema.request_body_schema;
  ns.properties = { ...ns.properties, version: { ...structuredClone(orderIdProp), type: "integer", description: "The version returned by the latest create_order or prepare_demo_checkout result." } };
  ns.required = [...new Set([...(ns.required ?? []), "version"])];
  actions.push("confirm_order: add version");
  if (!dry) {
    await call("PATCH", `/tools/${confirm.id}`, { tool_config: next });
    confirm.config = next;
  }
}
if (!byName.has("prepare_demo_checkout")) {
  actions.push("prepare_demo_checkout: create and attach");
  if (!dry) {
    const cfg = structuredClone(confirm.config);
    cfg.name = "prepare_demo_checkout";
    cfg.description = wanted.description;
    cfg.api_schema.url = cfg.api_schema.url.replace(/\/[^/]*$/, "/prepare_demo_checkout");
    const created = await call("POST", "/tools", { tool_config: cfg });
    const newId = created.id;
    if (!newId) throw new Error("Tool was created but no id came back.");
    const cur = await call("GET", `/agents/${id}`);
    const cc = cur.conversation_config ?? {};
    // The API returns both `tools` and `tool_ids` but accepts only one of them back.
    const { tools, ...curPrompt } = cc.agent?.prompt ?? {};
    const ids = [...(curPrompt.tool_ids ?? [])];
    if (!ids.includes(newId)) ids.push(newId);
    await call("PATCH", `/agents/${id}`, { conversation_config: { agent: { prompt: { ...curPrompt, tool_ids: ids } } } });
  }
}
console.log(actions.length ? `${dry ? "would apply" : "applied"}: ${actions.join("; ")}` : "already in sync: nothing to do");
