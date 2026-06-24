import { describe, expect, it } from "vitest";
import { countUncapturedDecisionPoints } from "./ask-user-question.js";

/** An AskUserQuestion tool_use offering option labels per question. */
function ask(id: string, questions: Array<{ question: string; options: string[] }>) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          id,
          input: {
            questions: questions.map((q) => ({
              question: q.question,
              options: q.options.map((label) => ({ label })),
            })),
          },
        },
      ],
    },
  };
}

/** The result record carrying chosen answers, linked back by tool_use_id. */
function result(id: string, answers: Record<string, string>) {
  return {
    type: "user",
    toolUseResult: { answers },
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  };
}

describe("countUncapturedDecisionPoints", () => {
  it("counts a free-form answer matching no offered option", () => {
    const records = [
      ask("a", [{ question: "Approach?", options: ["A", "B"] }]),
      result("a", { "Approach?": "neither — reconsider" }),
    ];
    expect(countUncapturedDecisionPoints(records)).toBe(1);
  });

  it("does not count an exact (trimmed) option match", () => {
    const records = [
      ask("a", [{ question: "Approach?", options: ["Approach A"] }]),
      result("a", { "Approach?": "  Approach A  " }),
    ];
    expect(countUncapturedDecisionPoints(records)).toBe(0);
  });

  it("counts free-form answers across multiple questions independently", () => {
    const records = [
      ask("a", [
        { question: "Q1?", options: ["yes", "no"] },
        { question: "Q2?", options: ["x"] },
      ]),
      result("a", { "Q1?": "yes", "Q2?": "something else entirely" }),
    ];
    // Q1 is an exact match (not counted); Q2 is free-form (counted).
    expect(countUncapturedDecisionPoints(records)).toBe(1);
  });

  it("returns 0 when there are no AskUserQuestion answers", () => {
    const records = [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    ];
    expect(countUncapturedDecisionPoints(records)).toBe(0);
  });

  it("returns 0 when an answer has no matching tool_use id", () => {
    const records = [
      ask("a", [{ question: "Q?", options: ["A"] }]),
      result("b", { "Q?": "free-form" }), // id mismatch
    ];
    expect(countUncapturedDecisionPoints(records)).toBe(0);
  });

  it("ignores empty question keys and empty / whitespace-only answers defensively", () => {
    const records = [
      ask("a", [{ question: "Q?", options: ["A"] }]),
      // empty-key entry, empty answer, and whitespace-only answer all skipped —
      // none is a confirmed selection NOR a meaningful free-form reply.
      result("a", { "": "free-form", "Q?": "   " }),
    ];
    expect(countUncapturedDecisionPoints(records)).toBe(0);
  });
});
