import { z } from "zod";
import { isCheckoutReference, type EditOrderBody } from "@solpouch/shared";
import { getCatalog } from "../merchants/index.js";
import { getOwnedOrder, HttpError, type Deps } from "./orders.js";
import { MAX_ITEM_QUANTITY, validateOrderLines } from "./orderValidation.js";

export const editDraftBody = z.object({
  version:z.number().int().positive(),
  lines:z.array(z.object({index:z.number().int().nonnegative(),qty:z.number().int().min(1).max(MAX_ITEM_QUANTITY),productId:z.string().min(1).max(200).optional()}).strict()).min(1).max(100),
}).strict();

export async function editDraft(deps: Deps, ownerEmail: string, id: string, input: EditOrderBody) {
  const body = editDraftBody.parse(input);
  const initial = await getOwnedOrder(deps,id,ownerEmail);
  return deps.store.withPouchLock(initial.pouchId,async()=>{
    const order = await getOwnedOrder(deps,id,ownerEmail);
    if (order.status !== "draft") throw new HttpError(409,"Only an unpaid draft can be edited.");
    if (order.version !== body.version) throw new HttpError(409,"This cart changed. Refresh before editing.","RecordChanged");
    const indices = new Set<number>();
    const reference = isCheckoutReference(order);
    const catalog = getCatalog(order.merchantId);
    const lines = body.lines.map(edit=>{
      if (indices.has(edit.index) || !order.lines[edit.index]) throw new HttpError(400,"Choose each existing cart item only once.");
      indices.add(edit.index);
      const previous = order.lines[edit.index];
      if (reference && edit.productId && edit.productId !== previous.product?.id) throw new HttpError(422,"Search items can only be removed or have their quantity changed. Search again for replacements.");
      const product = reference ? previous.product : catalog.find(p=>p.id === (edit.productId ?? previous.product?.id));
      if (!product || !product.inStock) throw new HttpError(422,"This item is unavailable. Remove it or choose an available catalog item.");
      const replaced = product.id !== previous.product?.id;
      return {...previous,product,qty:edit.qty,requestedQty:edit.qty,lineTotal:product.unitPrice*edit.qty,substitution:replaced || previous.substitution,...(replaced ? {note:"Replacement chosen by you.",matchScore:1} : {})};
    });
    // A handed-off cart remains a checkout reference after editing. Invalidate
    // the old URL, never silently turn it back into an internally payable cart.
    const fulfillment = order.fulfillment?.via === "instacart" ? {via:"instacart" as const,label:"Instacart shopping list",linkStatus:"unavailable" as const} : order.fulfillment;
    return deps.store.saveOrder({...order,lines,total:validateOrderLines(lines),fulfillment});
  });
}
