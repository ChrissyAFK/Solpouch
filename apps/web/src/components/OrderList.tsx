"use client";
import Link from "next/link";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { usd } from "@/components/ui";
import { Icon } from "@/components/Icons";

import { explorerTxUrl } from "@/lib/explorer";

export function sortOrders(orders: Order[]): Order[] {
  return [...orders].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export function OrderList({
  orders,
  merchants,
  pouches,
}: {
  orders: Order[];
  merchants: Merchant[];
  pouches: Pouch[] | null;
}) {
  return (
    <div className="orders-table">
      <div className="order-table-head" aria-hidden="true">
        <span>Store / Pouch</span>
        <span>Date</span>
        <span>Status</span>
        <span>Amount</span>
        <span />
      </div>
      {orders.map((o) => (
        // The receipt link sits beside the row Link: an <a> inside an <a> is invalid.
        <div key={o.id} style={{ position: "relative" }}>
        <Link
          href={`/order?order=${encodeURIComponent(o.id)}`}
          className="order-row"
        >
          <span className="order-identity">
            <strong>
              {o.store?.name ?? o.store?.domain ?? merchants.find((m) => m.id === o.merchantId)?.name ?? "Order"}
            </strong>
            <span>
              {pouches?.find((p) => p.id === o.pouchId)?.name ?? "Pouch"}
            </span>
          </span>
          <span className="order-date">
            {new Date(o.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </span>
          <span className={`order-status status-${o.status}`}>
            {o.status === "draft" ? "Awaiting review" : o.status === "paying" ? "Checking payment" : o.status}
          </span>
          <strong className="order-amount">{usd(toUsdc(o.total))}</strong>
          <Icon name="arrow" size={15} />
        </Link>
        {explorerTxUrl(o.txSignature) && (
          <a
            target="_blank"
            rel="noopener noreferrer"
            href={explorerTxUrl(o.txSignature)!}
            aria-label={`View ${merchants.find((m) => m.id === o.merchantId)?.name ?? o.store?.name ?? "order"} receipt on Solana Explorer (opens in a new tab)`}
            // In normal flow under the row, so it never covers the amount or status on phones.
            style={{
              display: "block",
              textAlign: "right",
              padding: "0 44px 8px 0",
              marginTop: -4,
              fontSize: 11,
              textDecoration: "underline",
            }}
          >
            receipt ↗
          </a>
        )}
        </div>
      ))}
    </div>
  );
}
