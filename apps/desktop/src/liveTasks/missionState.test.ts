import { describe, expect, it } from "vitest";
import {
  autoResumeHint,
  shouldAutoResumeMission,
  type MissionStateView,
} from "./missionState";

const resumable: MissionStateView = {
  missionId: "m_1a2b3c4d",
  status: "stopped",
  currentSliceId: "s2",
  iteration: 3,
};
const done: MissionStateView = { missionId: "m_1a2b3c4d", status: "success" };

describe("shouldAutoResumeMission", () => {
  it("honors explicit Riprendi even on the first prompt", () => {
    expect(
      shouldAutoResumeMission({
        mode: "zelari",
        mission: resumable,
        hasPriorUserTurn: false,
        explicit: true,
      }),
    ).toBe(true);
  });

  it("does not auto-resume the first prompt of a conversation", () => {
    expect(
      shouldAutoResumeMission({
        mode: "zelari",
        mission: resumable,
        hasPriorUserTurn: false,
      }),
    ).toBe(false);
  });

  it("auto-resumes follow-ups in zelari mode when the mission is resumable", () => {
    expect(
      shouldAutoResumeMission({
        mode: "zelari",
        mission: resumable,
        hasPriorUserTurn: true,
      }),
    ).toBe(true);
  });

  it("does not auto-resume kraken or council", () => {
    expect(
      shouldAutoResumeMission({
        mode: "kraken",
        mission: resumable,
        hasPriorUserTurn: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoResumeMission({
        mode: "council",
        mission: resumable,
        hasPriorUserTurn: true,
      }),
    ).toBe(false);
  });

  it("does not auto-resume a successful mission", () => {
    expect(
      shouldAutoResumeMission({
        mode: "zelari",
        mission: done,
        hasPriorUserTurn: true,
      }),
    ).toBe(false);
  });

  it("does not auto-resume without a mission on disk", () => {
    expect(
      shouldAutoResumeMission({
        mode: "zelari",
        mission: null,
        hasPriorUserTurn: true,
      }),
    ).toBe(false);
  });
});

describe("autoResumeHint", () => {
  it("names the mission and Italian status", () => {
    expect(autoResumeHint(resumable)).toBe(
      "Riprenderà la missione m_1a2b3c4d · ferma",
    );
  });
});
