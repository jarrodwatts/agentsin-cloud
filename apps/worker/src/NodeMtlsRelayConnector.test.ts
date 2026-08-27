import { expect, it } from "@effect/vitest";

import { makeOutboundFrameBudget } from "./NodeMtlsRelayConnector.ts";

it("bounds concurrent outbound sends by both frame count and encoded bytes", () => {
  const budget = makeOutboundFrameBudget({ maxQueuedFrames: 2, maxQueuedBytes: 10 });
  const releaseFirst = budget.acquire(6);
  const releaseSecond = budget.acquire(4);

  expect(releaseFirst).toBeTypeOf("function");
  expect(releaseSecond).toBeTypeOf("function");
  expect(budget.pendingFrames()).toBe(2);
  expect(budget.pendingBytes()).toBe(10);
  expect(budget.acquire(1)).toBeUndefined();

  releaseFirst?.();
  releaseFirst?.();
  expect(budget.pendingFrames()).toBe(1);
  expect(budget.pendingBytes()).toBe(4);
  expect(budget.acquire(7)).toBeUndefined();
  expect(budget.acquire(6)).toBeTypeOf("function");
});

it("rejects invalid byte counts without corrupting accounting", () => {
  const budget = makeOutboundFrameBudget({ maxQueuedFrames: 2, maxQueuedBytes: 10 });

  expect(budget.acquire(-1)).toBeUndefined();
  expect(budget.acquire(Number.NaN)).toBeUndefined();
  expect(budget.pendingFrames()).toBe(0);
  expect(budget.pendingBytes()).toBe(0);
});

it("rejects a tiny-frame flood and releases every reservation on close", () => {
  const budget = makeOutboundFrameBudget({ maxQueuedFrames: 32, maxQueuedBytes: 1_024 });
  const accepted = Array.from({ length: 100 }, () => budget.acquire(1)).filter(
    (release) => release !== undefined,
  );

  expect(accepted).toHaveLength(32);
  expect(budget.pendingFrames()).toBe(32);
  expect(budget.acquire(1)).toBeUndefined();
  budget.clear();
  expect(budget.pendingFrames()).toBe(0);
  expect(budget.pendingBytes()).toBe(0);
  expect(budget.acquire(1)).toBeTypeOf("function");
});
