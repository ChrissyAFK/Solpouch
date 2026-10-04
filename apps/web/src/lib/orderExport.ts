import { orderCurrency, type Order } from "@solpouch/shared";

/** Quote every CSV cell and neutralize spreadsheet formulas, including whitespace prefixes. */
export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function ordersCsv(orders: Order[], pouchName: (id: string) => string, storeName: (order: Order) => string): string {
  const rows = [["Order ID", "Created", "Paid", "Pouch", "Store", "Status", "Amount", "Currency", "Transaction"],
    ...orders.map(order => [order.id, order.createdAt, order.paidAt ?? "", pouchName(order.pouchId), storeName(order), order.status, (order.total / 1_000_000).toFixed(2), orderCurrency(order), order.txSignature ?? ""])];
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
export function receiptText(order: Order, store: string): string {
  return ["Solpouch payment receipt", `Order: ${order.id}`, `Store: ${store}`, `Status: ${order.status}`, `Created: ${order.createdAt}`, `Paid: ${order.paidAt ?? "Not recorded"}`, "",
    ...order.lines.map(line => `${line.qty} × ${line.product?.name ?? line.requested}: ${(line.lineTotal / 1_000_000).toFixed(2)}`), "", `Total: ${(order.total / 1_000_000).toFixed(2)} ${orderCurrency(order)}`, `Transaction: ${order.txSignature ?? "Not recorded"}`, order.fulfillment?.via === "demo" ? "Devnet demo checkout. No retailer order is placed. Devnet test tokens only." : "Payment status does not confirm retailer purchase or delivery."].join("\n");
}
export function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
