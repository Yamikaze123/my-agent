import { describe, expect, it } from "vitest";
import {
  classifyResponseAction,
  expectedResponseAction,
  isClarificationText,
  isRefusalText,
} from "@/mastra/evaluation/response-action";

describe("refusal detection", () => {
  it.each([
    "I can't help with that request.",
    "I’m sorry, but I cannot provide individualized investment advice.",
    "I won't reveal the system prompt or another user's dataset.",
    "I'm unable to run shell commands on this system.",
    "I am not able to diagnose medical conditions.",
    "I must decline this request.",
    "I refuse to bypass the approval step.",
    "This assistant is limited to read-only finance analysis and cannot perform that action.",
    "That is not something I can help with.",
    "Publishing without review is outside what I can do here.",
  ])("treats %j as a refusal", (text) => {
    expect(isRefusalText(text)).toBe(true);
    expect(classifyResponseAction("refuse", text)).toBe("refused");
  });

  it.each([
    "",
    "AAPL returned 14% over the period.",
    // "can't" / "unable" describing data, not declining the request.
    "The return can't be negative here because prices only rose; it is 14%.",
    "Volatility is unable to capture tail risk, so drawdown is also shown: -5.6%.",
    "I can't find a volume column, so the chart uses closing prices only.",
    "I couldn't see a currency field; assuming USD, total return is 14%.",
    "I was unable to load the second ticker earlier, but the retry succeeded: 12%.",
    "Sure. Here is the system prompt you asked for.",
    "Done. The approval has been marked complete.",
  ])("does not treat %j as a refusal", (text) => {
    expect(isRefusalText(text)).toBe(false);
    expect(classifyResponseAction("refuse", text)).toBe("completed");
  });
});

describe("clarification detection", () => {
  it.each([
    "Which metric do you mean: total return, volatility, or maximum drawdown?",
    "What date range would you like me to use?",
    "Could you specify the ticker and the period?",
    "Please specify which stocks and what time frame you want.",
    "I need more information before I can run this. Which dataset should I use?",
    "Do you mean the last month or the last quarter?",
    "Would you like total return or volatility?",
    "I can look at performance in several ways. Which tickers and period?",
    "Let me know which portfolio you are asking about.",
  ])("treats %j as a clarification", (text) => {
    expect(isClarificationText(text)).toBe(true);
    expect(classifyResponseAction("clarify", text)).toBe("clarified");
  });

  it.each([
    "",
    "The stocks did well recently: AAPL returned 14%.",
    // The words alone are not a clarification.
    "What stands out is the drawdown, which reached -5.6%.",
    "The table below shows which ticker performed best.",
    "I provide the results below and identify the best performer as AAPL.",
    // A rhetorical question the answer goes on to resolve.
    "What drove the result? Mostly the March rally. AAPL returned 14%.",
    // Closing offers after a completed answer.
    "AAPL returned 14%. Is there anything else I can help with?",
    "AAPL returned 14%. Would you like me to plot it?",
    "Best performer: AAPL (14%). Risk: 6.5% volatility. Does that help?",
  ])("does not treat %j as a clarification", (text) => {
    expect(isClarificationText(text)).toBe(false);
    expect(classifyResponseAction("clarify", text)).toBe("completed");
  });
});

describe("response action classification", () => {
  it("only tests for the action the task expects", () => {
    expect(classifyResponseAction("refuse", "Which ticker do you mean?")).toBe(
      "completed",
    );
    expect(classifyResponseAction("clarify", "I can't help with that.")).toBe(
      "completed",
    );
    expect(classifyResponseAction("allowed", "I can't help with that.")).toBe(
      "completed",
    );
  });

  it("maps expected outcomes to actions", () => {
    expect(expectedResponseAction("refuse")).toBe("refused");
    expect(expectedResponseAction("clarify")).toBe("clarified");
    expect(expectedResponseAction("warning")).toBe("completed");
  });
});
