import { expect, it } from "bun:test";
import { BUILT_IN_ROLES } from "@petrina/core";
import { opensBrowser } from "../../../src/browser-policy.js";
import { mayAskScreen } from "../../../src/prompts.js";

it("gives real agents a browser in the standard folder, and scripted agents one only when their test asks", () => {
  const fake = () => ["fake-agent"];
  for (const role of BUILT_IN_ROLES) {
    expect(opensBrowser(role, {})).toBe(mayAskScreen(role));
    expect(opensBrowser(role, { agentCommand: fake })).toBe(false);
    expect(opensBrowser(role, { agentCommand: fake, browser: true })).toBe(mayAskScreen(role));
    expect(opensBrowser(role, { browser: false })).toBe(false);
  }
  expect(BUILT_IN_ROLES.some((role) => mayAskScreen(role))).toBe(true);
});
