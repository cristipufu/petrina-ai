import { COMMAND_META } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { dispatch } from "../../../src/server.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";

const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("routine operations, product settings parity and read-only command metadata", () => {
  it("creates, lists, toggles and removes scheduled routines through external coordination", async () => {
    return owners.use(async ({ e, c }) => {
      const role = e.s.roles.find((entry) => entry.category === "maintenance") ?? e.s.roles[0]!;
      const profile = e.s.profiles[0]!;
      const saved = await c.call("routine.save", {
        name: "Weekly dependency check",
        productId: "product",
        roleId: role.id,
        profileId: profile.id,
        focus: "Check dependencies",
        schedule: { kind: "weekly", time: "09:30", weekdays: [1, 4] },
        zone: "UTC",
        enabled: true,
        requestId: "routine-create",
      });
      expect(saved.outcome).toBe("completed");
      const routineId = String(saved.routineId);
      const listed = await c.call("routine.list", { productId: "product" });
      expect(listed.outcome).toBe("completed");
      expect(listed.items).toEqual([
        expect.objectContaining({
          id: routineId,
          name: "Weekly dependency check",
          productId: "product",
          enabled: true,
        }),
      ]);
      expect(
        (await c.call("routine.enable", { routineId, enabled: false, requestId: "routine-disable" })).outcome,
      ).toBe("completed");
      expect(e.s.routines?.find((entry) => entry.id === routineId)?.enabled).toBe(false);
      expect((await c.call("routine.remove", { routineId, requestId: "routine-remove" })).outcome).toBe("completed");
      expect((await c.call("routine.list", {})).items).toEqual([]);
    });
  });

  it("exposes shipLowRisk and releaseBump in product.list and preserves omitted flags across both RPCs", async () => {
    return owners.use(async ({ e, c, taskId }) => {
      expect(
        (
          await c.call("product.settings", {
            productId: "product",
            name: "Example",
            delivery: "release",
            approveDelivery: true,
            shipLowRisk: true,
            releaseBump: "minor",
            requestId: "product-flags",
          })
        ).outcome,
      ).toBe("completed");

      await dispatch(e, {
        name: "updateProduct",
        args: ["product", { name: "Example Renamed", delivery: "pull-request", approveDelivery: true }],
      });
      const listed = await c.call("product.list", {});
      expect(listed.items).toEqual([
        expect.objectContaining({
          id: "product",
          name: "Example Renamed",
          delivery: "pull-request",
          approveDelivery: true,
          shipLowRisk: true,
          releaseBump: "minor",
        }),
      ]);

      expect(COMMAND_META.taskDetails.changes).toBe(false);
      expect(COMMAND_META.updateProduct.changes).toBe(true);
      const read = await dispatch(e, { name: "taskDetails", args: [taskId] });
      expect(read).toMatchObject({ id: taskId });
    });
  });
});
