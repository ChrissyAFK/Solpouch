import type {
  Merchant,
  Product,
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
  Allocation,
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
  const requestToken = new Headers(init?.headers).get("Authorization") ?? (token ? `Bearer ${token}` : null);
  if (res.status === 401 && requestToken === (getToken() ? `Bearer ${getToken()}` : null)) {
    clearSession();
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return res;
}

export class ApiRequestError extends Error {
  code?: string;
  status: number;
  /** Plain-language reasons a request was refused (e.g. account deletion). */
  blockers?: string[];
  constructor(status: number, body: ApiError & { blockers?: string[] }) {
    super(body.error);
    this.status = status;
    this.code = body.code;
    this.blockers = body.blockers;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const token = getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    res = await authFetch(BACKEND_URL + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: init?.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      if (res.status === 401 && getToken() === token) clearSession();
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
        blockers: Array.isArray((body as { blockers?: unknown }).blockers) ? (body as { blockers: unknown[] }).blockers.filter((b): b is string => typeof b === "string") : undefined,
      });
    }
    if (res.status === 204) return undefined as T;
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
  wallet: string | null;
  createdAt: string | number;
};
export type UpdateProfileBody = {
  displayName?: string | null;
  avatar?: string | null;
};

export type WalletUser = { email: string; name?: string; picture?: string; wallet?: string };
export type AuthSession = { id: string; createdAt: string; expiresAt: string; current: boolean };

export type FundingRequest = { id: string; direction: "BUY" | "SELL"; country: "US" | "CA"; currency: "USD" | "CAD"; amount: string; wallet: string; environment: "staging"; status: "created" | "session_ready" | "session_uncertain" | "processing" | "provider_completed" | "sandbox_completed" | "confirmed" | "failed" | "cancelled" | "refunded"; createdAt: string; updatedAt: string; providerOrderId?: string; txSignature?: string; cryptoAmount?: string; message?: string };
export type TransakFundingConfig = { provider?: "transak"; environment: "staging"; productionEnabled: false; configured: boolean; countries: { country: "US" | "CA"; currency: "USD" | "CAD"; buyEnabled: boolean; sellEnabled: boolean }[]; notice: string };
export type ShoppingListItem = { name: string; qty: number };
export type ShoppingList = { id: string; version?: number; name: string; items: ShoppingListItem[]; createdAt: string; updatedAt: string };
export type StripeFundingConfig = { provider: "stripe"; environment: "test"; configured: boolean; usdPerCad: string; minAmountCad: number; maxAmountCad: number; mintEnabled: boolean };
export type StripeFundingRequest = { id: string; provider: "stripe"; status: "created" | "checkout_ready" | "paid" | "confirmed" | "expired"; amountCad: string; usdcAmount: string; wallet: string; sessionId?: string; txSignature?: string; createdAt: string; updatedAt: string };
export type FundingConfig = TransakFundingConfig | StripeFundingConfig;

export const api = {
  shoppingListStatus: () => req<{ temporary: boolean }>("/shopping-lists/status"),
  shoppingLists: () => req<ShoppingList[]>("/shopping-lists"),
  saveShoppingList: (body: { name: string; items: ShoppingListItem[] }) => post<ShoppingList>("/shopping-lists", body),
  updateShoppingList: (id: string, body: { version: number; name: string; items: ShoppingListItem[] }) => req<ShoppingList>(`/shopping-lists/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteShoppingList: (id: string, version: number) => req<void>(`/shopping-lists/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ version }) }),
  draftShoppingList: (id: string, version: number, pouchId?: string) => post<Order>(`/shopping-lists/${encodeURIComponent(id)}/draft`, { version, pouchId }),
  products: (merchantId: string) => req<Product[]>(`/merchants/${encodeURIComponent(merchantId)}/products`),
  editOrder: (id: string, version: number, lines: { index: number; qty: number; productId?: string }[]) => req<Order>(`/orders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ version, lines }) }),
  prepareDemoCheckout: (id: string, version: number) => post<Order>(`/orders/${encodeURIComponent(id)}/demo-checkout`, { version }),
  stripeCheckout: (body: { amountCad: string; idempotencyKey: string }) => post<{ request: StripeFundingRequest; url?: string }>("/funding/stripe/checkout", body),
  stripeFunding: (id: string, signal?: AbortSignal) => req<StripeFundingRequest>(`/funding/stripe/${encodeURIComponent(id)}`, { signal }),
  stripeHistory: () => req<StripeFundingRequest[]>("/funding/stripe"),
  fundingConfig: () => req<FundingConfig>("/funding/config"),
  fundingRequests: () => req<FundingRequest[]>("/funding"),
  startFunding: (body: { country: "US" | "CA"; direction: "BUY" | "SELL"; amount: string; idempotencyKey: string }) => post<{ request: FundingRequest; widgetUrl?: string }>("/funding", body),
  reconcileFunding: (id: string) => post<FundingRequest>(`/funding/${encodeURIComponent(id)}/reconcile`),
  sessions: () => req<{ sessions: AuthSession[] }>("/auth/sessions"),
  logout: (token: string, all = false) => req<{ ok: boolean }>(all ? "/auth/logout-all" : "/auth/logout", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  }),
  revokeSession: (id: string) => req<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAccount: () => req<{ ok: boolean }>("/auth/account", { method: "DELETE" }),
  privyToken: () => req<{ token: string; expiresAt: string }>("/auth/privy-token"),
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
  voiceToken: (signal?: AbortSignal) =>
    req<{ token: string; expiresAt?: string }>("/auth/voice-token", { method: "POST", signal }),
  voiceSession: (signal?: AbortSignal) =>
    req<{ signedUrl: string; conversationToken?: string; token: string; expiresAt: number | string }>("/auth/voice-session", { method: "POST", signal }),
  voiceStatus: () => req<{ enabled: boolean }>("/auth/voice-status"),
  walletChallenge: (wallet: string) =>
    post<{ id: string; message: string; expiresAt: string }>("/auth/wallet/challenge", { wallet }),
  walletVerify: (id: string, signature: string) =>
    post<{ user: WalletUser }>("/auth/wallet/verify", { id, signature }),
  unlinkWallet: () => req<{ user: WalletUser }>("/auth/wallet", { method: "DELETE" }),
  merchants: () => req<Merchant[]>("/merchants"),
  createInstacartLink: (id: string) => post<Order>(`/orders/${encodeURIComponent(id)}/instacart`),
  createOrder: (b: CreateOrderBody, opts?: { autoPay?: boolean }) =>
    post<Order & { autoPaid?: boolean; autoPayError?: { code: string; message: string } }>("/orders", opts?.autoPay === undefined ? b : { ...b, autoPay: opts.autoPay }),
  orders: (pouchId?: string) =>
    req<Order[]>(
      `/orders${pouchId ? `?pouchId=${encodeURIComponent(pouchId)}` : ""}`,
    ),
  order: (id: string) => req<Order>(`/orders/${id}`),
  confirm: (id: string, version?: number) => post<Order>(`/orders/${id}/confirm`, { version }),
  cancel: (id: string) => post<Order>(`/orders/${id}/cancel`),
  startTopUp: (b: StartTopUpBody) => post<TopUp>("/topups", b),
  topUp: (id: string) => req<TopUp>(`/topups/${encodeURIComponent(id)}`),
  completeTopUp: (id: string) => post<TopUp>(`/topups/${id}/complete`),
  cancelTopUp: (id: string) => post<TopUp>(`/topups/${id}/cancel`),
  prepareAllocation: (pouchId: string, amount: number) =>
    post<{ allocationId: string; transaction: string; lastValidBlockHeight: number }>(
      "/allocations/prepare",
      { pouchId, amount },
    ),
  completeAllocation: (id: string, signature: string) =>
    post<Allocation>(`/allocations/${encodeURIComponent(id)}/complete`, { signature }),
  listPendingTopUps: (pouchId?: string) =>
    req<TopUp[]>(`/topups${pouchId ? `?pouchId=${encodeURIComponent(pouchId)}` : ""}`),
  startWithdrawal: (b: StartWithdrawalBody) =>
    post<Withdrawal>("/withdrawals", b),
  listWithdrawals: (pouchId: string) =>
    req<Withdrawal[]>(`/withdrawals?pouchId=${encodeURIComponent(pouchId)}`),
  withdrawalConfig: () =>
    req<{ holdSeconds: number; simulated: boolean }>("/withdrawals/config"),
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
      InstacartNotConfigured: "Instacart shopping links are not configured yet. No purchase was made.",
      InstacartUnavailable: "Instacart could not prepare the shopping list. No purchase was made. Try again shortly.",
      PaymentPending: e.message,
      PaymentNotSent: e.message,
      LookupFailed: e.message,
      SearchUnavailable: "Product search is not available right now. Try again in a moment.",
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
      ZeroAmount: "The amount must be more than zero.",
      ZeroLimit: "Limits must be more than zero.",
      PerOrderOverDaily: "The limit per order cannot be higher than the daily limit.",
      DuplicateMerchant: "Each store can only be added to a pouch once.",
      ConfirmAboveTooHigh: "The automatic payment amount cannot be higher than the limit per order.",
      MerchantTokenNotAta: "This store's payment account is not set up correctly. No money moved.",
      WalletRequired: "Link a wallet to add money.",
      WalletProofInvalid: "The wallet signature was invalid or expired. Try linking again.",
    };
    return (e.code && messages[e.code]) || e.message;
  }
  return "Something went wrong. Try again in a moment.";
}
