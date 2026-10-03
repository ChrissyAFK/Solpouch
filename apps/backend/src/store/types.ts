import type { Order, Pouch, TopUp } from "@solpouch/shared";

/** Persistence boundary. TODO: PostgresStore (Tiger Data) implementing this same interface. */
export interface Store {
  listPouches(): Promise<Pouch[]>;
  getPouch(id: string): Promise<Pouch | undefined>;
  savePouch(p: Pouch): Promise<Pouch>;

  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;

  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
}
