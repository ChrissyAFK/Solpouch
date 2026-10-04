import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MemoryStore} from "../src/store/memory.js";
import {ownedSeed,TEST_USER} from "./helpers.js";
import {demoRate,prepareDemoCheckout} from "../src/services/demoCheckout.js";
import {autoConfirmEligible,confirmOrder,type Deps} from "../src/services/orders.js";
import {isCheckoutReference,orderCurrency,type Order} from "@solpouch/shared";
import {editDraft} from "../src/services/shopping.js";
import {PaymentPending} from "../src/vault/recovery.js";
import type {VaultClient} from "../src/vault/types.js";
let deps:Deps; let draft:Order;
const payTo="11111111111111111111111111111111";
beforeEach(async()=>{
  vi.stubEnv("VAULT_MODE","chain");vi.stubEnv("DEMO_RETAILER_PAYMENTS","1");vi.stubEnv("FUNDING_USD_PER_CAD","0.73");vi.stubEnv("CHECKOUT_PAY_TO",payTo);
  const store=new MemoryStore(ownedSeed().map(p=>({...p,allowedMerchantIds:["web:mcdonalds.com"]})));
  // Explicit fake chain capability; no RPC or real funds are used in this suite.
  const vault={assertDevnet:vi.fn(async()=>{}),pay:vi.fn(async()=>({txSignature:"fixture-signature"}))} as unknown as VaultClient;
  deps={store,vault};
  draft=await store.saveOrder({id:"a".repeat(32),pouchId:"uber-eats",merchantId:"web:mcdonalds.com",request:"burger",createdAt:new Date().toISOString(),status:"draft",total:4990000,store:{name:"McDonald's",domain:"mcdonalds.com"},fulfillment:{via:"service",label:"Retailer checkout"},lines:[{requested:"burger",requestedQty:1,qty:1,lineTotal:4990000,matchScore:.8,substitution:false,product:{id:"web:burger",merchantId:"web:mcdonalds.com",name:"Burger",unitPrice:4990000,inStock:true,estimated:true}}]});
});
afterEach(()=>vi.unstubAllEnvs());
it("does not pay reference estimates and requires ownership",async()=>{
 await expect(confirmOrder(deps,TEST_USER,draft.id,draft.version)).rejects.toMatchObject({code:"WebCheckoutRequired"});
 await expect(prepareDemoCheckout(deps,"other@example.com",draft.id,draft.version!)).rejects.toMatchObject({status:404});
 expect(deps.vault.pay).not.toHaveBeenCalled();
});
it("requires explicit enabled chain and real devnet capability",async()=>{
 for(const [key,value] of [["DEMO_RETAILER_PAYMENTS","0"],["VAULT_MODE","mock"]]){vi.stubEnv(key,value);await expect(prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!)).rejects.toMatchObject({code:"DemoUnavailable"});vi.stubEnv(key,key==="VAULT_MODE"?"chain":"1");}
 deps.vault.assertDevnet=vi.fn(async()=>{throw new Error("wrong genesis")});
 await expect(prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!)).rejects.toThrow("wrong genesis");
 expect(deps.vault.pay).not.toHaveBeenCalled();
});
it("converts persisted provenance, binds new approval, and never auto pays",async()=>{
 const quote=await prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!);
 expect(quote.total).toBe(3642700);expect(quote.fulfillment?.demo?.sourceTotal).toBe(4990000);expect(orderCurrency(quote)).toBe("USDC");expect(isCheckoutReference(quote)).toBe(false);
 expect(deps.vault.pay).not.toHaveBeenCalled();expect(autoConfirmEligible({... (await deps.store.getPouch(draft.pouchId))!,confirmAbove:100000000},quote)).toBe(false);
 await expect(confirmOrder(deps,TEST_USER,draft.id,draft.version)).rejects.toMatchObject({code:"RecordChanged"});
 await expect(editDraft(deps,TEST_USER,draft.id,{version:quote.version!,lines:[{index:0,qty:2}]})).rejects.toMatchObject({status:409});
 const paid=await confirmOrder(deps,TEST_USER,draft.id,quote.version);
 expect(paid.status).toBe("paid");expect(deps.vault.pay).toHaveBeenCalledWith(expect.anything(),payTo,3642700,draft.id);
 await confirmOrder(deps,TEST_USER,draft.id,quote.version);expect(deps.vault.pay).toHaveBeenCalledTimes(1);
});
it("rejects stale preparation and configuration drift before payment",async()=>{
 const quote=await prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!);
 await expect(prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!)).rejects.toMatchObject({code:"RecordChanged"});
 vi.stubEnv("FUNDING_USD_PER_CAD","0.74");await expect(confirmOrder(deps,TEST_USER,draft.id,quote.version)).rejects.toMatchObject({code:"RecordChanged"});expect(deps.vault.pay).not.toHaveBeenCalled();
});
it("serializes simultaneous approval into one transfer",async()=>{
 const quote=await prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!);
 const paid=await Promise.all([confirmOrder(deps,TEST_USER,draft.id,quote.version),confirmOrder(deps,TEST_USER,draft.id,quote.version)]);
 expect(paid.every(o=>o.status==="paid")).toBe(true);expect(deps.vault.pay).toHaveBeenCalledTimes(1);
});

it("recovers an already persisted payment even after demo gate is disabled",async()=>{
 const quote=await prepareDemoCheckout(deps,TEST_USER,draft.id,draft.version!);
 vi.mocked(deps.vault.pay).mockImplementationOnce(async()=>{
  await deps.store.saveOperation({id:`pay:${quote.id}`,kind:"pay",pouchId:quote.pouchId,txSignature:"fixture-signature",signedTransaction:"fixture-only",lastValidBlockHeight:100,createdAt:new Date().toISOString()});
  throw new PaymentPending();
 });
 await expect(confirmOrder(deps,TEST_USER,draft.id,quote.version)).rejects.toMatchObject({code:"PaymentPending"});
 vi.stubEnv("DEMO_RETAILER_PAYMENTS","0");
 expect((await confirmOrder(deps,TEST_USER,draft.id,quote.version)).status).toBe("paid");
});
it("voice preparation gives exact test-token consent and enforces readback delay",async()=>{
 const {createApp}=await import("../src/app.js");const {voiceToken}=await import("./helpers.js");
 const app=createApp(deps); const token=await voiceToken(deps.store);
 const request=(tool:string,body:object)=>app.request(`/voice/tools/${tool}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 const quote=await (await request("prepare_demo_checkout",{orderId:draft.id,version:draft.version})).json();
 expect(quote.say).toContain("3.64 USDC");expect(quote.say).toContain(payTo);
 const early=await (await request("confirm_order",{orderId:draft.id,version:quote.version})).json();
 expect(early.needsConfirmation).toBe(true);expect(deps.vault.pay).not.toHaveBeenCalled();
});

it("rejects USDC catalog carts handed off to Instacart",async()=>{
 const order=await deps.store.saveOrder({...draft,store:undefined,merchantId:"catalog",fulfillment:{via:"instacart",label:"Instacart"},lines:draft.lines.map(line=>({...line,product:{...line.product!,merchantId:"catalog",estimated:false}}))});
 expect(orderCurrency(order)).toBe("USDC");
 await expect(prepareDemoCheckout(deps,TEST_USER,order.id,order.version!)).rejects.toMatchObject({status:422});
 expect(deps.vault.pay).not.toHaveBeenCalled();
});
it("rejects a demo conversion rate above the Stripe bound",()=>{
 vi.stubEnv("FUNDING_USD_PER_CAD","73");expect(()=>demoRate()).toThrow("Checkout conversion is not configured.");
 vi.stubEnv("FUNDING_USD_PER_CAD","2");expect(demoRate()).toBe("2");
});
