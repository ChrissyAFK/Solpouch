import { Hono } from "hono";
import { getCatalog, getMerchant, merchants } from "../merchants/index.js";
import { HttpError } from "../services/orders.js";

export function merchantRoutes() {
  const app = new Hono();
  app.get("/", (c) => c.json(merchants));
  app.get("/:id/products", (c) => {
    const id = c.req.param("id");
    if (!getMerchant(id)) throw new HttpError(404, "Merchant not found");
    return c.json(getCatalog(id));
  });
  return app;
}
