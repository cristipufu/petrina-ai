import { describe, expect, it } from "vitest";
import { checkSourceHints } from "../../../src/index.js";

describe("portable source pointer hint validation", () => {
  it("retains up to eight distinct valid pointers for registered product ids and explains omitted entries", () => {
    const pointer = { productId: "shop", revision: "a".repeat(40), path: "docs/design.md" };
    for (const none of [undefined, null, []]) {
      expect(checkSourceHints(none, ["shop"])).toEqual({ pointers: [] });
    }
    const site = { ...pointer, productId: "site" };
    const mixed = checkSourceHints(
      [
        pointer,
        { ...pointer, recommendation: "Extra field" },
        { ...pointer, path: "../escape" },
        { ...pointer, revision: "main" },
        { ...pointer, productId: "acme/shop" },
        { ...pointer, productId: " shop" },
        pointer,
        site,
      ],
      ["shop", "site"],
    );
    expect(mixed).toEqual({
      pointers: [pointer, site],
      left: "Left out 5 optional source locations: 2 did not name one of this task's products by its exact id; 3 were not repository locations at a full source version. Kept 2.",
    });
    const many = Array.from({ length: 10 }, (_, index) => ({ ...pointer, path: `file-${index}.md` }));
    expect(checkSourceHints(many, ["shop"])).toEqual({
      pointers: many.slice(0, 8),
      left: "Left out 2 optional source locations: 2 went past the limit of eight. Kept 8.",
    });
  });
});
