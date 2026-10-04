import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth/session.js";
import type { StoredShoppingList } from "../store/types.js";
import { createDraft, HttpError, type Deps } from "../services/orders.js";
import { MAX_ITEM_QUANTITY } from "../services/orderValidation.js";

const content = z.object({name:z.string().trim().min(1).max(80),items:z.array(z.object({name:z.string().trim().min(1).max(120).refine(v=>!/[\r\n]/.test(v),"Use one item per line"),qty:z.number().int().min(1).max(MAX_ITEM_QUANTITY)}).strict()).min(1).max(50)}).strict();
const version = z.object({version:z.number().int().positive()}).strict();
function publicList(list: StoredShoppingList) { const {ownerEmail,...visible}=list; return visible; }

export function shoppingListRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  const owned = async(id:string,email:string)=>{
    const list=await deps.store.getShoppingList(id);
    if(!list || list.ownerEmail!==email) throw new HttpError(404,"Shopping list not found");
    return list;
  };
  app.get("/status",c=>c.json({temporary:deps.store.persistentLists !== true}));
  app.get("/",async c=>c.json((await deps.store.listShoppingLists(c.get("user").email)).map(publicList)));
  app.post("/",async c=>{
    const body=content.parse(await c.req.json());
    const now=new Date().toISOString();
    return c.json(publicList(await deps.store.saveShoppingList({...body,id:randomUUID(),ownerEmail:c.get("user").email,createdAt:now,updatedAt:now})),201);
  });
  app.patch("/:id",async c=>{
    const body=content.extend({version:version.shape.version}).parse(await c.req.json());
    const list=await owned(c.req.param("id"),c.get("user").email);
    if(list.version!==body.version) throw new HttpError(409,"This list changed. Refresh before saving.","RecordChanged");
    return c.json(publicList(await deps.store.saveShoppingList({...list,...body,updatedAt:new Date().toISOString()})));
  });
  app.delete("/:id",async c=>{
    const body=version.parse(await c.req.json());
    const list=await owned(c.req.param("id"),c.get("user").email);
    await deps.store.deleteShoppingList(list.id,list.ownerEmail,body.version);
    return c.body(null,204);
  });
  app.post("/:id/draft",async c=>{
    const body=version.extend({pouchId:z.string().min(1).max(100).optional()}).parse(await c.req.json());
    const list=await owned(c.req.param("id"),c.get("user").email);
    if(list.version!==body.version) throw new HttpError(409,"This list changed. Refresh before using it.","RecordChanged");
    // Only requests are reused. Product availability and prices are resolved now.
    const request=list.items.map(item=>`${item.qty} ${item.name}`).join(", ");
    return c.json(await createDraft(deps,list.ownerEmail,request,body.pouchId,list.items.map(item=>({requested:item.name,qty:item.qty}))),201);
  });
  return app;
}
