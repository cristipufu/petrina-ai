import { stateFixture } from "./state.js";

export function productState() {
  return stateFixture({ now: 0, products: [
    { id: "p", name: "Petrina AI", repo: "acme/petrina-ai", path: "/code/petrina-ai", tone: "blue", delivery: "pull-request", approveDelivery: true },
    { id: "q", name: "Shop API", repo: "acme/shop-api", tone: "green" },
  ] });
}
