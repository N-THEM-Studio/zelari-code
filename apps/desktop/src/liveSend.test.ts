import { describe, expect, it } from "vitest";
import { classifyLiveSend, shouldAutoSendFollowUp } from "./liveSend";

describe("classifyLiveSend", () => {
  it("idle → new turn", () => {
    expect(
      classifyLiveSend({
        running: false,
        steerSupported: true,
        alreadySteeredThisRun: false,
      }),
    ).toBe("new_turn");
  });

  it("first send on a live v2 run → steer", () => {
    expect(
      classifyLiveSend({
        running: true,
        steerSupported: true,
        alreadySteeredThisRun: false,
      }),
    ).toBe("steer");
  });

  it("further sends while still running → queue", () => {
    expect(
      classifyLiveSend({
        running: true,
        steerSupported: true,
        alreadySteeredThisRun: true,
      }),
    ).toBe("queue");
  });

  it("running without steer capability → queue (composer stays usable)", () => {
    expect(
      classifyLiveSend({
        running: true,
        steerSupported: false,
        alreadySteeredThisRun: false,
      }),
    ).toBe("queue");
  });
});

describe("shouldAutoSendFollowUp", () => {
  it("dispatches the queued text when the composer is empty", () => {
    expect(
      shouldAutoSendFollowUp({
        queued: "descrivilo in maniera più semplice",
        draft: "",
        wasCancelled: false,
      }),
    ).toBe("descrivilo in maniera più semplice");
  });

  it("dispatches when the draft is the idle prefill of the same text", () => {
    expect(
      shouldAutoSendFollowUp({
        queued: "descrivilo in maniera più semplice",
        draft: "descrivilo in maniera più semplice",
        wasCancelled: false,
      }),
    ).toBe("descrivilo in maniera più semplice");
  });

  it("does not steal a draft the user edited to something else", () => {
    expect(
      shouldAutoSendFollowUp({
        queued: "descrivilo in maniera più semplice",
        draft: "no, fai altro",
        wasCancelled: false,
      }),
    ).toBeNull();
  });

  it("does not dispatch after a cancelled run", () => {
    expect(
      shouldAutoSendFollowUp({
        queued: "next please",
        draft: "",
        wasCancelled: true,
      }),
    ).toBeNull();
  });

  it("does not dispatch an empty queue", () => {
    expect(
      shouldAutoSendFollowUp({
        queued: undefined,
        draft: "",
        wasCancelled: false,
      }),
    ).toBeNull();
  });
});
