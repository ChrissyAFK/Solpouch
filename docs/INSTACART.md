# Instacart shopping-list links

Solpouch creates an Instacart shopping list. The customer chooses products/store, reviews current prices, and pays on Instacart. This does not spend a pouch's USDC, place an order, or verify purchase/delivery. Creating a link makes that Solpouch draft reference-only, preventing a second payment through the pouch.

## Configure

Set `INSTACART_API_KEY` on the backend only and `INSTACART_ENV=dev` for a development key. Use `INSTACART_ENV=production` only with a production key. Never put the key in a `NEXT_PUBLIC_` variable. Without configuration, the action returns a clear503 and does not fabricate a checkout link.

On an unpaid cart, choose **Create Instacart shopping list**. `POST /orders/:id/instacart` checks ownership, serializes changes, calls `POST /idp/v1/products/products_link`, and persists the returned link and expiration. A fresh cached link is reused. Paid/cancelled orders cannot be handed off. Names and quantities are sent using `line_item_measurements` with unit `each`; customers must verify Instacart's matches.

Only HTTPS links under Instacart domains are accepted. Provider failures, invalid URLs and timeouts cannot mark the cart paid. The API key and provider error bodies are never returned to the browser.

## Verification

`pnpm --filter @solpouch/backend exec vitest run test/instacart.test.ts` checks configuration failures, request shape, unsafe URL rejection, ownership, reuse and no payment. These are mocked-provider tests. A live development API key is required to validate account access and open a generated list; that check is separate from these tests.

Documentation checked: https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page

Full purchase/delivery tracking is not included in this shopping-list integration. It requires an appropriate provider contract and verified order events.
