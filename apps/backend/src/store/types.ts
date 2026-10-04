import type { Order, Pouch, TopUp } from "@solpouch/shared";

/** A pouch as stored: carries its owner. Never send ownerEmail over the API, use publicPouch(). */
export type StoredPouch = Pouch & { ownerEmail?: string };
export function publicPouch(p: StoredPouch): Pouch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ownerEmail: _o, ...rest } = p;
  return rest;
}

export type UserProfile = { email: string; displayName?: string; avatar?: string; createdAt: string; updatedAt: string };

/** Persistence boundary. */
export interface Store {
  /** With ownerEmail, only that user's pouches. Without, all (internal use only). */
  listPouches(ownerEmail?: string): Promise<StoredPouch[]>;
  getPouch(id: string): Promise<StoredPouch | undefined>;
  savePouch(p: StoredPouch): Promise<StoredPouch>;

  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;

  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
  /** Newest first. */
  listTopUps(pouchId: string): Promise<TopUp[]>;

  getUser(email: string): Promise<UserProfile | undefined>;
  saveUser(u: UserProfile): Promise<UserProfile>;
}
