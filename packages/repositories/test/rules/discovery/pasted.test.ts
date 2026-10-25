import { describe, expect, it } from "bun:test";
import { expandPastedPath as expandPath } from "../../../src/pasted-path.js";

describe("Adding a product", () => {
it("expands pasted paths", () => {
    expect(expandPath("~", "/home/me", "linux")).toBe("/home/me");
    expect(expandPath(" ~/code/shop ", "/home/me", "linux")).toBe("/home/me/code/shop");
    expect(expandPath("'/Users/me/My Code/shop'", "/home/me", "darwin")).toBe("/Users/me/My Code/shop");
    expect(expandPath("/Users/me/My\\ Code/shop", "/home/me", "darwin")).toBe("/Users/me/My Code/shop");
    expect(expandPath("code/shop", "/home/me", "linux")).toBe("/home/me/code/shop");
    expect(expandPath("~", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me");
    expect(expandPath("~/code/shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath("~\\code\\shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath('"C:\\My Code\\shop"', "C:\\Users\\me", "win32")).toBe("C:\\My Code\\shop");
    expect(expandPath("code/shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath("\\\\server\\share\\shop", "C:\\Users\\me", "win32")).toBe("\\\\server\\share\\shop");
  });
});
