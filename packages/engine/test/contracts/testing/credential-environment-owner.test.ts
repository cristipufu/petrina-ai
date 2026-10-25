import { expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as leases from "@petrina/test-support/process-lease";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { credentialedDelivery } from "../../fixtures/security-delivery.js";
import { expectRejection } from "@petrina/test-support/rejections";

it("releases the credential fixture's lease when its program cannot be written", async () => {
  const root = tempDir("petrina-credential-fixture-owner-");
  const file = join(root, "not-a-folder");
  writeFileSync(file, "This path cannot contain a program");
  let prepared = 0, closed = 0;
  const lease = spyOn(leases, "createProcessLease").mockResolvedValue({
    program() { prepared++; return "process.exit(0)"; },
    async close() { closed++; },
  });
  try {
    await expectRejection(credentialedDelivery({ kind: "ssh", mode: "pull-request", world: { dir: file, data: root, clone: root, remote: root }, evil: root, ssh: "unused-private-program" }));
    expect(prepared).toBe(1);
    expect(closed).toBe(1);
  } finally { lease.mockRestore(); removeDir(root); }
});
