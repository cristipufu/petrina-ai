import { oneTaskFixture } from "../../fixtures/state";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";

describe("check cleanup", () => {
  it("shows when Petrina could not confirm that child processes stopped", () => {
    const state = oneTaskFixture(1_000_000_000);
    const task = {
      ...state.tasks[0]!,
      findings: [],
      checks: {
        at: state.now,
        results: [{
          name: "Tests",
          command: "bun test",
          ms: 1_000,
          ok: false,
          cleanupIncomplete: true,
          output: "Petrina could not confirm every child process stopped. Some may still be running.",
        }],
      },
    };
    const html = renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    expect(html).toContain("Petrina could not confirm every child process stopped. Some may still be running.");
  });
});
