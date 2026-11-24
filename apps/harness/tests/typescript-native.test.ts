import { expect, test } from "bun:test";

enum NativeResult {
  Ready = 1,
}

namespace NativeSyntax {
  export class Value {
    constructor(public readonly result: NativeResult) {}
  }
}

test("the project toolchain accepts enums, namespaces and constructor parameter properties", () => {
  expect(new NativeSyntax.Value(NativeResult.Ready).result).toBe(NativeResult.Ready);
});
