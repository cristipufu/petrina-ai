import * as native from "bun:test";
import { observedCases } from "./cases.js";
import { finishFile } from "./events.js";

// A new private native worker loads this before its test module. No test source is rewritten.
const base = { ...native };
const observed = observedCases(base);
native.mock.module("bun:test", () => ({ ...base, ...observed }));
native.afterAll(finishFile);
