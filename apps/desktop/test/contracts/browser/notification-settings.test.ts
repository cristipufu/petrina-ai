import { describe, expect, it } from "vitest";
import { getSettings, sendTest, setNotificationsOn } from "../../../src/notify/settings";

describe("the test notification", () => {
  it("a Mac test that is still waiting never goes out once notifications are switched off", async () => {
    setNotificationsOn(true);
    const sent: string[] = [];
    let release = () => undefined as void;
    const waiting = sendTest(async () => sent.push("test"), 5000, () => new Promise<void>((resolve) => (release = resolve)));
    setNotificationsOn(false);
    release();
    expect(await waiting).toBe("off");
    expect(sent).toEqual([]);
    expect(getSettings().on).toBe(false);
  });

  it("goes out after the wait while notifications stay on", async () => {
    setNotificationsOn(true);
    const sent: string[] = [];
    expect(await sendTest(async () => sent.push("test"), 5000, async () => undefined)).toBe("sent");
    expect(sent).toEqual(["test"]);
  });
});
