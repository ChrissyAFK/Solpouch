import type {
  Merchant,
  Pouch,
  Order,
  TopUp,
  SpendPoint,
  CreatePouchBody,
  UpdateRulesBody,
  CreateOrderBody,
  StartTopUpBody,
  Withdrawal,
  StartWithdrawalBody,
  ApiError,
} from "@solpouch/shared";
import { clearSession, getToken } from "./session";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787";

export const SESSION_EXPIRED_EVENT = "solpouch:session-expired";

/** fetch with the Google Bearer token; a 401 clears the session. */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit) {
  const token = getToken();
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return res;
}

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    res = await authFetch(BACKEND_URL + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      const body =
        data && typeof data === "object" ? (data as Partial<ApiError>) : {};
      const message =
        // Coded errors (e.g. "nothing was charged") and 503 notices are written for users.
        res.status >= 500 &&
        !body.code &&
        (res.status !== 503 || typeof body.error !== "string")
          ? "Solpouch is having trouble right now. Try again in a moment."
          : typeof body.error === "string"
            ? body.error
            : "This request could not be completed. Try again.";
      throw new ApiRequestError(res.status, {
        error: message,
        code: body.code,
      });
    }
    if (data === undefined)
      throw new ApiRequestError(res.status, {
        error: "We couldn't read the response. Try again.",
      });
    return data as T;
  } catch (cause) {
    if (cause instanceof ApiRequestError) throw cause;
    const changingData = init?.method && init.method !== "GET";
    throw new ApiRequestError(0, {
      error: changingData
        ? "We couldn't confirm the result. Refresh and check the latest status before trying again."
        : controller.signal.aborted
          ? "This is taking too long. Check your connection and try again."
          : "We couldn't connect to Solpouch. Check your connection and try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
}

const post = <T>(p: string, body?: unknown) =>
  req<T>(p, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export type Profile = {
  email: string;
  name: string;
  picture: string;
  displayName: string | null;
  avatar: string | null;
  googleName: string;
  googlePicture: string;
  createdAt: string | number;
};
export type UpdateProfileBody = {
  displayName?: string | null;
  avatar?: string | null;
};

export type WalletUser = {
  email: string;
  name?: string;
  picture?: string;
  wallet?: string;
};

export const api = {
  getProfile: () => req<Profile>("/profile"),
  updateProfile: (b: UpdateProfileBody) =>
    req<Profile>("/profile", { method: "PATCH", body: JSON.stringify(b) }),
  pouches: () => req<Pouch[]>("/pouches"),
  pouch: (id: string) => req<Pouch>(`/pouches/${id}`),
  createPouch: (b: CreatePouchBody) => post<Pouch>("/pouches", b),
  updateRules: (id: string, b: UpdateRulesBody) =>
    req<Pouch>(`/pouches/${id}/rules`, {
      method: "PATCH",
      body: JSON.stringify(b),
    }),
  freeze: (id: string) => post<Pouch>(`/pouches/${id}/freeze`),
  unfreeze: (id: string) => post<Pouch>(`/pouches/${id}/unfreeze`),
  voiceToken: () => post<{ token: string }>("/auth/voice-token"),
  voiceSession: () =>
    post<{ signedUrl: string; token: string; expiresAt: number | string }>(
      "/auth/voice-session",
    ),
  voiceStatus: () => req<{ enabled: boolean }>("/auth/voice-status"),
  walletChallenge: (wallet: string) =>
    post<{ id: string; message: string }>("/auth/wallet/challenge", { wallet }),
  walletVerify: (id: string, signature: string) =>
    post<{ user: WalletUser }>("/auth/wallet/verify", { id, signature }),
  unlinkWallet: () =>
    req<{ user: WalletUser }>("/auth/wallet", { method: "DELETE" }),
  merchants: () => req<Merchant[]>("/merchants"),
  createOrder: (b: CreateOrderBody) => post<Order>("/orders", b),
  orders: (pouchId?: string) =>
    req<Order[]>(
      `/orders${pouchId ? `?pouchId=${encodeURIComponent(pouchId)}` : ""}`,
    ),
  order: (id: string) => req<Order>(`/orders/${id}`),
  confirm: (id: string) => post<Order>(`/orders/${id}/confirm`),
  cancel: (id: string) => post<Order>(`/orders/${id}/cancel`),
  startTopUp: (b: StartTopUpBody) => post<TopUp>("/topups", b),
  topUp: (id: string) => req<TopUp>(`/topups/${encodeURIComponent(id)}`),
  completeTopUp: (id: string) => post<TopUp>(`/topups/${id}/complete`),
  cancelTopUp: (id: string) => post<TopUp>(`/topups/${id}/cancel`),
  listPendingTopUps: (pouchId: string) =>
    req<TopUp[]>(`/topups?pouchId=${encodeURIComponent(pouchId)}`),
  startWithdrawal: (b: StartWithdrawalBody) =>
    post<Withdrawal>("/withdrawals", b),
  listWithdrawals: (pouchId: string) =>
    req<Withdrawal[]>(`/withdrawals?pouchId=${encodeURIComponent(pouchId)}`),
  cancelWithdrawal: (id: string) =>
    post<Withdrawal>(`/withdrawals/${encodeURIComponent(id)}/cancel`),
  spend: (pouchId: string, bucket: "day" | "hour" = "day") =>
    req<SpendPoint[]>(
      `/stats/spend?pouchId=${encodeURIComponent(pouchId)}&bucket=${bucket}`,
    ),
  freezeAll: () => post<Pouch[]>("/pouches/freeze-all"),
};

export function errMsg(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const messages: Record<string, string> = {
      PaymentPending: e.message,
      PaymentNotSent: e.message,
      LookupFailed: e.message,
      PouchFrozen: "This pouch is frozen. Unfreeze it first.",
      MerchantNotAllowed:
        "This store is not allowed for this pouch. Choose another pouch or update its allowed stores.",
      OverPerOrderLimit:
        "The total is above this pouch's limit per order. Reduce the order or update the limit.",
      OverDailyLimit: "This payment would exceed the pouch's daily limit.",
      InsufficientFunds:
        "This pouch does not have enough funds for this payment.",
      WithdrawalPending:
        "This pouch already has a withdrawal on hold. Cancel it to start a new one.",
      CooldownActive:
        "The waiting period has not ended. Wait for the timer before completing the top-up.",
      OrderAlreadyUsed:
        "This order has already been paid. Refresh to see its latest status.",
      Unauthorized: "You do not have permission to make this change.",
    };
    return (e.code && messages[e.code]) || e.message;
  }
  return "Something went wrong. Try again in a moment.";
}
