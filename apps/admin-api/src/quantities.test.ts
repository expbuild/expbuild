import test from "node:test";
import assert from "node:assert/strict";
import { quantityExceeds } from "./quantities.js";
test("resource comparisons preserve decimal, binary and large integer quantities", () => {
  for (const [a, b] of [
    [".5", "500m"],
    ["1.5Gi", "1536Mi"],
    ["1e3", "1k"],
    ["1E", "1000000000G"],
    ["0.1m", "100u"],
    ["+1.", "1000m"],
  ]) {
    assert.equal(quantityExceeds(a, b), false);
    assert.equal(quantityExceeds(b, a), false);
  }
  for (const [a, b] of [
    ["501m", "0.5"],
    ["1Gi", "1G"],
    ["9007199254740993", "9007199254740992"],
    ["1n", "0"],
  ]) {
    assert.equal(quantityExceeds(a, b), true);
    assert.equal(quantityExceeds(b, a), false);
  }
  for (const value of [
    "",
    "-1Gi",
    "NaN",
    "Infinity",
    "1e999999",
    "1e-999999",
    "1watts",
    "0x10",
    "x".repeat(129),
  ])
    assert.throws(() => quantityExceeds(value, "1"));
});
