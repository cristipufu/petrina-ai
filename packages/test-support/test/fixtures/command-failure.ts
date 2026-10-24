import { expect } from "bun:test";
import { CommandFailure } from "../../src/commands.js";
import { rejectionOf } from "../../src/rejections.js";

export async function failureOf(work: Promise<unknown>): Promise<CommandFailure> {
  const error = await rejectionOf(work);
  expect(error).toBeInstanceOf(CommandFailure);
  return error as CommandFailure;
}
