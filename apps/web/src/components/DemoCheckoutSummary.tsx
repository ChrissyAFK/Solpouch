import { toUsdc, type Order } from "@solpouch/shared";
export function DemoCheckoutSummary({ order }: { order: Order }) {
  const demo = order.fulfillment?.via === "demo" ? order.fulfillment.demo : undefined;
  if (!demo) return null;
  return <div className="my-3 space-y-2 text-sm" aria-label="Demo checkout details"><strong>Devnet demo checkout</strong><p>No retailer order is placed. Devnet test tokens only.</p><p>Source estimate: {toUsdc(demo.sourceTotal).toFixed(2)} CAD · Rate: {demo.usdPerCad} USDC per CAD</p><p>Payment: {toUsdc(order.total).toFixed(6)} test-USDC</p><p className="break-all">Checkout wallet: {demo.payTo}</p></div>;
}
