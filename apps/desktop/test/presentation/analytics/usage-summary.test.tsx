

import { stateFixture } from "../../fixtures/state";
import { describe, expect, it, vi } from "vitest";
import { usageNote } from "../../../src/components/Usage";

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: {} }));

describe('usage by tool', () => {
  it('has nothing to flag when every tool is fine', () => {
    const state = stateFixture(1_000_000_000);
    expect(usageNote({ ...state, pool: { ...state.pool, usage: [] } })).toBeUndefined();
  });
});
