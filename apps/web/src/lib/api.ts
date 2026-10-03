import type {
  Merchant, Pouch, Order, TopUp, SpendPoint, CreatePouchBody, UpdateRulesBody,
  CreateOrderBody, StartTopUpBody, ApiError,
} from "@solpouch/shared";

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787";

export class ApiRequestError extends Error {
  code?: string;
  status: number;
  constructor(status: number, body: ApiError) {
    super(body.error);
    this.status = status;
    this.code = body.code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BACKEND_URL + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(0, { error: `Cannot reach backend at ${BACKEND_URL}` });
  }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* non-json */ }
  if (!res.ok) {
    const b = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(res.status, { error: b.error ?? `Request failed (${res.status})`, code: b.code });
  }
  return data as T;
}

const post = <T>(p: string, body?: unknown) =>
  req<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  pouches: () => req<Pouch[]>("/pouches"),
  pouch: (id: string) => req<Pouch>(`/pouches/${id}`),
  createPouch: (b: CreatePouchBody) => post<Pouch>("/pouches", b),
  updateRules: (id: string, b: UpdateRulesBody) =>
    req<Pouch>(`/pouches/${id}/rules`, { method: "PATCH", body: JSON.stringify(b) }),
  freeze: (id: string) => post<Pouch>(`/pouches/${id}/freeze`),
  unfreeze: (id: string) => post<Pouch>(`/pouches/${id}/unfreeze`),
  merchants: () => req<Merchant[]>("/merchants"),
  createOrder: (b: CreateOrderBody) => post<Order>("/orders", b),
  orders: (pouchId?: string) => req<Order[]>(`/orders${pouchId ? `?pouchId=${encodeURIComponent(pouchId)}` : ""}`),
  order: (id: string) => req<Order>(`/orders/${id}`),
  confirm: (id: string) => post<Order>(`/orders/${id}/confirm`),
  cancel: (id: string) => post<Order>(`/orders/${id}/cancel`),
  startTopUp: (b: StartTopUpBody) => post<TopUp>("/topups", b),
  completeTopUp: (id: string) => post<TopUp>(`/topups/${id}/complete`),
  spend: (pouchId: string, bucket: "day" | "hour" = "day") =>
    req<SpendPoint[]>(`/stats/spend?pouchId=${encodeURIComponent(pouchId)}&bucket=${bucket}`),
};

export function errMsg(e: unknown): string {
  if (e instanceof ApiRequestError) return e.code ? `${e.message} (${e.code})` : e.message;
  return e instanceof Error ? e.message : String(e);
}
