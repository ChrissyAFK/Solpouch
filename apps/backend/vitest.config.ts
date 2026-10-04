import { defineConfig } from "vitest/config";

export default defineConfig({
  // Price checks fetch real product pages; tests turn them off (findCart.test.ts turns them back on with fakes).
  test: { env: { VERIFY_PRICES: "0" } },
});
