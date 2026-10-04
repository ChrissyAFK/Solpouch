import {beforeEach,describe,expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import {MemoryStore} from "../src/store/memory.js";
import {MockVaultClient} from "../src/vault/mock.js";
import {getCatalog,getMerchant} from "../src/merchants/index.js";
import {createDraft} from "../src/services/orders.js";
import {authHeaders,ownedSeed,TEST_USER,voiceToken} from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
let store:MemoryStore; let vault:MockVaultClient; let app:ReturnType<typeof createApp>; let headers:Record<string,string>;
const request=(path:string,method="GET",body?:unknown,auth=headers)=>app.request(path,{method,headers:{...auth,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
beforeEach(async()=>{store=new MemoryStore(ownedSeed());vault=new MockVaultClient(store,id=>getMerchant(id)?.payTo);app=createApp({store,vault});headers=await authHeaders(store);});
describe("saved shopping requests",()=>{
  it("reports temporary demo storage only to signed-in users",async()=>{
    expect((await request("/shopping-lists/status","GET",undefined,{})).status).toBe(401);
    expect(await (await request("/shopping-lists/status")).json()).toEqual({temporary:true});
  });
  it("requires a session, hides ownership and prevents cross-account access",async()=>{
    expect((await request("/shopping-lists","GET",undefined,{})).status).toBe(401);
    const created=await request("/shopping-lists","POST",{name:"Week",items:[{name:"milk",qty:2}]});expect(created.status).toBe(201);
    const list=await created.json();expect(list.ownerEmail).toBeUndefined();
    const other=await authHeaders(store,"other@example.com");
    expect(await (await request("/shopping-lists","GET",undefined,other)).json()).toEqual([]);
    for(const [method,path,body] of [["PATCH","",{version:list.version,name:"Stolen",items:list.items}],["DELETE","",{version:list.version}],["POST","/draft",{version:list.version}]] as const) expect((await request(`/shopping-lists/${list.id}${path}`,method,body,other)).status).toBe(404);
  });
  it("validates quantities and rejects stale writes and stale deletes",async()=>{
    expect((await request("/shopping-lists","POST",{name:"Week",items:[{name:"milk",qty:0}]})).status).toBe(400);
    const list=await (await request("/shopping-lists","POST",{name:"Week",items:[{name:"milk",qty:2}]})).json();
    const payload={version:list.version,name:"Updated",items:list.items};
    const responses=await Promise.all([request(`/shopping-lists/${list.id}`,"PATCH",payload),request(`/shopping-lists/${list.id}`,"PATCH",payload)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await request(`/shopping-lists/${list.id}`,"DELETE",{version:list.version})).status).toBe(409);
    expect((await request(`/shopping-lists/${list.id}/draft`,"POST",{version:list.version})).status).toBe(409);
    expect((await request(`/shopping-lists/${list.id}`,"DELETE",{version:list.version+1})).status).toBe(204);
  });
  it("reuses requests as fresh drafts with current catalog prices and exact quantities",async()=>{
    const list=await (await request("/shopping-lists","POST",{name:"Lunch",items:[{name:"pad thai",qty:2}]})).json();
    const a=await (await request(`/shopping-lists/${list.id}/draft`,"POST",{version:list.version,pouchId:"uber-eats"})).json();
    const b=await (await request(`/shopping-lists/${list.id}/draft`,"POST",{version:list.version,pouchId:"uber-eats"})).json();
    expect(a.id).not.toBe(b.id);expect(a.status).toBe("draft");expect(a.lines[0].qty).toBe(2);
    expect(a.total).toBe(getCatalog("thai-express").find(p=>p.id===a.lines[0].product.id)!.unitPrice*2);
    expect(b.txSignature).toBeUndefined();
  });
});
describe("draft cart edits and approval",()=>{
  it("resolves replacement prices on the server and binds approval to the reviewed version",async()=>{
    const order=await createDraft({store,vault},TEST_USER,"pad thai","uber-eats");
    const product=getCatalog(order.merchantId).find(p=>p.inStock && p.id!==order.lines[0].product?.id)!;
    expect((await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:1,productId:product.id,unitPrice:1}]})).status).toBe(400);
    const response=await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:1,productId:product.id}]});expect(response.status).toBe(200);
    const changed=await response.json();expect(changed.total).toBe(product.unitPrice);
    const pay=vi.spyOn(vault,"pay");
    expect((await request(`/orders/${order.id}/confirm`,"POST")).status).toBe(409);
    expect((await request(`/orders/${order.id}/confirm`,"POST",{version:order.version})).status).toBe(409);expect(pay).not.toHaveBeenCalled();
    expect((await request(`/orders/${order.id}/confirm`,"POST",{version:changed.version})).status).toBe(200);
    expect((await request(`/orders/${order.id}`,"PATCH",{version:changed.version,lines:[{index:0,qty:1}]})).status).toBe(409);
    expect((await request(`/orders/${order.id}/confirm`,"POST")).status).toBe(200);
  });
  it("serializes concurrent edits and hides other users carts",async()=>{
    const order=await createDraft({store,vault},TEST_USER,"pad thai","uber-eats");
    const payload={version:order.version,lines:[{index:0,qty:2}]};
    expect((await request(`/orders/${order.id}`,"PATCH",payload,await authHeaders(store,"other@example.com"))).status).toBe(404);
    const responses=await Promise.all([request(`/orders/${order.id}`,"PATCH",payload),request(`/orders/${order.id}`,"PATCH",payload)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const latest=(await store.getOrder(order.id))!;
    expect((await request(`/orders/${order.id}`,"PATCH",{version:latest.version,lines:[{index:0,qty:2},{index:0,qty:1}]})).status).toBe(400);
  });
  it("invalidates checkout links and keeps estimates unpayable",async()=>{
    const draft=await createDraft({store,vault},TEST_USER,"pad thai","uber-eats");
    const order=await store.saveOrder({...draft,merchantId:"web:example.com",store:{name:"Example",domain:"example.com"},lines:draft.lines.map(l=>({...l,product:l.product?{...l.product,estimated:true}:null})),fulfillment:{via:"instacart",label:"Shopping list",checkoutUrl:"https://www.instacart.com/test",linkStatus:"ready"}});
    expect((await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:2,productId:"invented"}]})).status).toBe(422);
    const changed=await (await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:2}]})).json();
    expect(changed.fulfillment.checkoutUrl).toBeUndefined();expect(changed.fulfillment.via).toBe("instacart");expect(changed.lines[0].product.estimated).toBe(true);
    expect((await request(`/orders/${order.id}/confirm`,"POST",{version:changed.version})).status).toBe(422);
  });
  it("removes omitted lines and refuses empty carts",async()=>{
    const order=await createDraft({store,vault},TEST_USER,"pad thai and spring rolls","uber-eats");
    expect(order.lines.length).toBeGreaterThan(1);
    const response=await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:1}]});
    expect(response.status).toBe(200);const changed=await response.json();
    expect(changed.lines).toHaveLength(1);expect(changed.total).toBe(changed.lines[0].product.unitPrice);
    expect((await request(`/orders/${order.id}`,"PATCH",{version:changed.version,lines:[]})).status).toBe(400);
  });
  it("voice approval refuses an older cart version without claiming payment",async()=>{
    const order=await createDraft({store,vault},TEST_USER,"pad thai","uber-eats");
    await request(`/orders/${order.id}`,"PATCH",{version:order.version,lines:[{index:0,qty:1}]});
    const token=await voiceToken(store);
    const response=await request("/voice/tools/confirm_order","POST",{orderId:order.id,version:order.version},{Authorization:`Bearer ${token}`});
    const body=await response.json();expect(body.code).toBe("RecordChanged");expect(body.status).toBe("draft");expect(body.say).toContain("Review");
    expect((await store.getOrder(order.id))!.status).toBe("draft");
  });

});
