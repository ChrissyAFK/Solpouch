import type { Context } from 'hono';
import type { Store } from '../store/types.js';
import { HttpError, type Deps } from '../services/orders.js';

declare module 'hono' { interface ContextVariableMap { deps: Deps; wallet: string } }

export function requestDeps(c: Context): Deps { return c.get('deps') as Deps; }
export function ownedStore(base: Store, wallet: string): Store {
  const pouch = async (id: string) => { const p = await base.getPouch(id); return p?.ownerWallet === wallet ? p : undefined; };
  const requirePouch = async (id: string) => { if (!await pouch(id)) throw new HttpError(404, 'Pouch not found'); };
  return new Proxy(base, { get(target, property) {
    switch (property) {
      case 'listPouches': return async () => (await base.listPouches()).filter(p => p.ownerWallet === wallet);
      case 'getPouch': return pouch;
      case 'savePouch': return async (p: Parameters<Store['savePouch']>[0]) => {
        const existing = await base.getPouch(p.id);
        if (existing && existing.ownerWallet !== wallet) throw new HttpError(404, 'Pouch not found');
        return base.savePouch({ ...p, ownerWallet: wallet });
      };
      case 'listOrders': return async (id?: string) => {
        if (id) await requirePouch(id);
        const owned = new Set((await base.listPouches()).filter(p => p.ownerWallet === wallet).map(p => p.id));
        return (await base.listOrders(id)).filter(o => owned.has(o.pouchId));
      };
      case 'getOrder': return async (id: string) => { const o = await base.getOrder(id); return o && await pouch(o.pouchId) ? o : undefined; };
      case 'getTopUp': return async (id: string) => { const t = await base.getTopUp(id); return t && await pouch(t.pouchId) ? t : undefined; };
      case 'saveOrder': return async (o: Parameters<Store['saveOrder']>[0]) => {
        await requirePouch(o.pouchId); const old = await base.getOrder(o.id);
        if (old) { await requirePouch(old.pouchId); if (old.pouchId !== o.pouchId) throw new HttpError(409, 'Order pouch cannot change'); }
        return base.saveOrder(o);
      };
      case 'saveTopUp': return async (t: Parameters<Store['saveTopUp']>[0]) => {
        await requirePouch(t.pouchId); const old = await base.getTopUp(t.id);
        if (old) { await requirePouch(old.pouchId); if (old.pouchId !== t.pouchId) throw new HttpError(409, 'Top-up pouch cannot change'); }
        return base.saveTopUp(t);
      };
      default: { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
    }
  } });
}
