import { StoreConflictError } from "../src/store/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { AuthUnavailableError, signSession, signVoiceToken } from "../src/auth/session.js";
import { consumeAiBudget } from "../src/security/rateLimit.js";
import { authHeaders } from "./helpers.js";
const user = { email:"a@example.test", name:"Alice", picture:"" };
const setup = () => { const store=new MemoryStore([]); const deps={store,vault:new MockVaultClient(store,()=>undefined),verifyGoogle:async()=>user}; return {store,app:createApp(deps),deps}; };
afterEach(()=>vi.unstubAllEnvs());
describe("persisted session boundaries",()=>{
  it("revokes web and parent-bound voice tokens across app instances",async()=>{
    const {store,app,deps}=setup(); const {token,session}=await signSession(user,store); const voice=await signVoiceToken(session);
    vi.stubEnv("ELEVENLABS_TOOL_SECRET","fixture-secret");
    const headers={Authorization:`Bearer ${token}`};
    const tool=()=>createApp(deps).request("/voice/tools/get_pouches",{method:"POST",headers:{Authorization:`Bearer ${voice.token}`,"X-Solpouch-Secret":"fixture-secret"},body:"{}"});
    expect((await tool()).status).toBe(200);
    expect((await app.request("/auth/logout",{method:"POST",headers})).status).toBe(200);
    expect((await createApp(deps).request("/pouches",{headers})).status).toBe(401);
    expect((await tool()).status).toBe(401);
  });
  it("lists and revokes only this account's sessions, and revokes all devices",async()=>{
    const {store,app}=setup(); const first=await signSession(user,store); const second=await signSession(user,store); const foreign=await signSession({...user,email:"b@example.test"},store);
    const headers={Authorization:`Bearer ${first.token}`};
    const listed=await(await app.request("/auth/sessions",{headers})).json();
    expect(listed.sessions).toHaveLength(2); expect(listed.sessions.find((s:any)=>s.current).id).toBe(first.session.id);
    expect((await app.request(`/auth/sessions/${foreign.session.id}`,{method:"DELETE",headers})).status).toBe(404);
    expect((await app.request(`/auth/sessions/${second.session.id}`,{method:"DELETE",headers})).status).toBe(200);
    expect((await app.request("/auth/me",{headers:{Authorization:`Bearer ${second.token}`}})).status).toBe(401);
    expect((await app.request("/auth/logout-all",{method:"POST",headers})).status).toBe(200);
    expect(await store.listSessions(user.email)).toEqual([]);
    expect((await app.request("/auth/me",{headers:{Authorization:`Bearer ${foreign.token}`}})).status).toBe(200);
  });
  it("rejects expired persisted sessions, including voice credentials",async()=>{
    const {store,app}=setup(); const {token,session}=await signSession(user,store); const voice=await signVoiceToken(session);
    await store.deleteSession(session.id); await store.saveSession({...session,expiresAt:new Date(Date.now()-1).toISOString()});
    expect((await app.request("/auth/me",{headers:{Authorization:`Bearer ${token}`}})).status).toBe(401);
    vi.stubEnv("ELEVENLABS_TOOL_SECRET","fixture-secret");
    expect((await app.request("/voice/tools/get_pouches",{method:"POST",headers:{"X-Solpouch-Secret":"fixture-secret"},body:JSON.stringify({user_token:voice.token})})).status).toBe(401);
  });
  it("reports valid-login database/provider outages as 503, not invalid credentials",async()=>{
    const {store,app,deps}=setup(); vi.spyOn(store,"getUser").mockRejectedValue(new Error("private database detail"));
    const r=await app.request("/auth/google",{method:"POST",body:JSON.stringify({credential:"valid-fixture"})});
    expect(r.status).toBe(503); expect(await r.text()).not.toContain("private database detail");
    const unavailable=createApp({...deps,verifyGoogle:async()=>{throw new AuthUnavailableError("Google sign-in is temporarily unavailable");}});
    expect((await unavailable.request("/auth/google",{method:"POST",body:'{"credential":"valid"}'})).status).toBe(503);
  });
  it("shares account AI budgets between chat and order/voice operations across app instances",async()=>{
    const {store,app,deps}=setup(); const headers=await authHeaders(store,user.email);
    for(let i=0;i<10;i++) await consumeAiBudget(store,user.email);
    const result=await app.request("/chat",{method:"POST",headers,body:'{"messages":[{"role":"user","content":"balance"}]}'});
    expect(result.status).toBe(429); expect(Number(result.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await createApp(deps).request("/orders",{method:"POST",headers,body:'{"request":"milk"}'})).status).toBe(429);
    vi.stubEnv("ELEVENLABS_TOOL_SECRET","fixture-secret"); const parent=await signSession(user,store); const voice=await signVoiceToken(parent.session);
    expect((await createApp(deps).request("/voice/tools/create_order",{method:"POST",headers:{"X-Solpouch-Secret":"fixture-secret"},body:JSON.stringify({request:"milk",user_token:voice.token})})).status).toBe(429);
    const another=await authHeaders(store,"other@example.test");
    expect((await app.request("/chat",{method:"POST",headers:another,body:'{"messages":[{"role":"user","content":"balance"}]}'})).status).toBe(200);
  });
});


describe("storage conflict API boundary", () => {
  it("returns a safe 409 for a concurrent write conflict", async () => {
    const { store, app } = setup();
    const headers = await authHeaders(store);
    vi.spyOn(store, "updateUser").mockRejectedValueOnce(new StoreConflictError("private storage detail"));
    const response = await app.request("/profile", {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "New name" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This record changed. Refresh and try again.", code: "RecordChanged" });
  });
});
