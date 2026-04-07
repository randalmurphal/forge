import { describe, expect, it } from "vitest";

import { createOrchestrationRecoveryCoordinator } from "./orchestrationRecovery";

describe("createOrchestrationRecoveryCoordinator", () => {
  it("defers live events until bootstrap completes and then requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");

    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      nextExpectedSequence: 3,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("classifies sequence gaps as recovery-only replay work", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(5)).toBe("recover");
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "replay",
      reason: "sequence-gap",
    });
  });

  it("tracks live event batches without entering recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);

    expect(coordinator.classifyDomainEvent(4)).toBe("apply");
    expect(coordinator.markEventBatchApplied([{ sequence: 4 }])).toEqual([{ sequence: 4 }]);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 4,
      nextExpectedSequence: 5,
      highestObservedSequence: 4,
      bootstrapped: true,
      inFlight: null,
    });
  });

  it("requests another replay when deferred events arrive during replay recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.classifyDomainEvent(7);
    coordinator.markEventBatchApplied([{ sequence: 4 }, { sequence: 5 }, { sequence: 6 }]);

    expect(coordinator.completeReplayRecovery()).toBe(true);
  });

  it("does not immediately replay again when replay returns no new events", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.classifyDomainEvent(5);
    coordinator.beginReplayRecovery("sequence-gap");

    expect(coordinator.completeReplayRecovery()).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      latestSequence: 3,
      nextExpectedSequence: 4,
      highestObservedSequence: 5,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("marks replay failure as unbootstrapped so snapshot fallback is recovery-only", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    coordinator.beginReplayRecovery("sequence-gap");
    coordinator.failReplayRecovery();

    expect(coordinator.getState()).toMatchObject({
      bootstrapped: false,
      inFlight: null,
    });
    expect(coordinator.beginSnapshotRecovery("replay-failed")).toBe(true);
    expect(coordinator.getState().inFlight).toEqual({
      kind: "snapshot",
      reason: "replay-failed",
    });
  });

  it("keeps enough state to explain why bootstrap snapshot recovery requests replay", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(true);
    expect(coordinator.classifyDomainEvent(4)).toBe("defer");
    expect(coordinator.completeSnapshotRecovery(2)).toBe(true);

    expect(coordinator.getState()).toMatchObject({
      latestSequence: 2,
      nextExpectedSequence: 3,
      highestObservedSequence: 4,
      bootstrapped: true,
      pendingReplay: false,
      inFlight: null,
    });
  });

  it("reports skip state when snapshot recovery is requested while replay is in flight", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(3);
    expect(coordinator.beginReplayRecovery("sequence-gap")).toBe(true);

    expect(coordinator.beginSnapshotRecovery("bootstrap")).toBe(false);
    expect(coordinator.getState()).toMatchObject({
      pendingReplay: true,
      inFlight: {
        kind: "replay",
        reason: "sequence-gap",
      },
    });
  });

  it("classifies consecutive events in a synchronous batch as apply without triggering recovery", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(10);

    // Simulate a synchronous batch: multiple events classified before any are
    // flushed via markEventBatchApplied. Previously this would cause the 2nd+
    // events to trigger "recover" because latestSequence hadn't advanced yet.
    expect(coordinator.classifyDomainEvent(11)).toBe("apply");
    expect(coordinator.classifyDomainEvent(12)).toBe("apply");
    expect(coordinator.classifyDomainEvent(13)).toBe("apply");
    expect(coordinator.classifyDomainEvent(14)).toBe("apply");

    expect(coordinator.getState()).toMatchObject({
      latestSequence: 10,
      nextExpectedSequence: 15,
      highestObservedSequence: 14,
      inFlight: null,
    });

    // Now the microtask flush applies them.
    coordinator.markEventBatchApplied([
      { sequence: 11 },
      { sequence: 12 },
      { sequence: 13 },
      { sequence: 14 },
    ]);

    expect(coordinator.getState()).toMatchObject({
      latestSequence: 14,
      nextExpectedSequence: 15,
    });
  });

  it("ignores events already classified as apply but not yet flushed", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(5);

    expect(coordinator.classifyDomainEvent(6)).toBe("apply");
    expect(coordinator.classifyDomainEvent(7)).toBe("apply");

    // Duplicate of 6 arrives (e.g. from replay overlapping with live stream).
    expect(coordinator.classifyDomainEvent(6)).toBe("ignore");

    // Next in sequence still works.
    expect(coordinator.classifyDomainEvent(8)).toBe("apply");
  });

  it("detects a genuine gap even after a successful batch", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(5);

    expect(coordinator.classifyDomainEvent(6)).toBe("apply");
    expect(coordinator.classifyDomainEvent(7)).toBe("apply");
    // Sequence 8 is missing — genuine gap.
    expect(coordinator.classifyDomainEvent(9)).toBe("recover");
  });

  it("replay after batch flush advances from the correct applied cursor", () => {
    const coordinator = createOrchestrationRecoveryCoordinator();

    coordinator.beginSnapshotRecovery("bootstrap");
    coordinator.completeSnapshotRecovery(5);

    // Synchronous batch.
    expect(coordinator.classifyDomainEvent(6)).toBe("apply");
    expect(coordinator.classifyDomainEvent(7)).toBe("apply");

    // Flush those two.
    coordinator.markEventBatchApplied([{ sequence: 6 }, { sequence: 7 }]);

    // A gap triggers recovery.
    expect(coordinator.classifyDomainEvent(10)).toBe("recover");
    coordinator.beginReplayRecovery("sequence-gap");

    // Replay should start from latestSequence (7), not nextExpectedSequence.
    expect(coordinator.getState().latestSequence).toBe(7);
  });
});
