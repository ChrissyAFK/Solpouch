import { toMicros, type Merchant, type Product } from "@solpouch/shared";
import mountain from "./catalogs/mountain-market.json" with { type: "json" };
import builders from "./catalogs/burnaby-builders.json" with { type: "json" };
import thai from "./catalogs/thai-express.json" with { type: "json" };

interface RawProduct {
  id: string;
  name: string;
  brand?: string;
  size?: string;
  price: number;
  inStock: boolean;
}

export const merchants: Merchant[] = [
  { id: "mountain-market", name: "Mountain Market", payTo: "2Eh7wvgnA1MQu1hLnPHZAjrguvGzXgkaKF3tGqvxpFzK", kind: "grocery" },
  { id: "burnaby-builders", name: "Burnaby Builders Supply", payTo: "BbSupp9QxW3mKd7TnRz2VhYc5LuEoJ8aPgF4sXiN6vDr", kind: "building_supply" },
  { id: "thai-express", name: "Thai Express (gift card)", payTo: "DAqP69yePkq18Uv9AmGKaNUF7CuAsgwF1yhnCzwDaDj3", kind: "food" },
];

function toProducts(merchantId: string, raw: RawProduct[]): Product[] {
  return raw.map((r) => ({
    id: r.id,
    merchantId,
    name: r.name,
    brand: r.brand,
    size: r.size,
    unitPrice: toMicros(r.price),
    inStock: r.inStock,
  }));
}

const catalogs: Record<string, Product[]> = {
  "mountain-market": toProducts("mountain-market", mountain as RawProduct[]),
  "burnaby-builders": toProducts("burnaby-builders", builders as RawProduct[]),
  "thai-express": toProducts("thai-express", thai as RawProduct[]),
};

const webMerchants = new Map<string, Merchant>();
export const registerWebMerchant = (m: Merchant): Merchant => {
  webMerchants.set(m.id, m);
  return m;
};
export const getMerchant = (id: string) => merchants.find((m) => m.id === id) ?? webMerchants.get(id);
export const getCatalog = (merchantId: string): Product[] => catalogs[merchantId] ?? [];
