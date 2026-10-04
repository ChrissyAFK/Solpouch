import { toUsdc, type Order } from "@solpouch/shared";
export function DemoCheckoutSummary({ order }: { order: Order }) {
  const demo = order.fulfillment?.via === "demo" ? order.fulfillment.demo : undefined;
  if (!demo) return null;
  return <div className="my-3 space-y-2 text-sm" aria-label="Checkout details"><strong>Checkout</strong><p>Source estimate: {toUsdc(demo.sourceTotal).toFixed(2)} CAD · Rate: {demo.usdPerCad} USDC per CAD</p><p>Payment: {toUsdc(order.total).toFixed(2)} USDC</p><p className="break-all">Checkout wallet: {demo.payTo}</p></div>;
}
