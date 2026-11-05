import { describe, expect, it } from "vitest";
import { sendWithOutcome, type EmailSender } from "../src/emails.js";

const payload = {
  from: "test@example.com",
  to: "test@example.com",
  template: {
    id: "fake-template-id",
    variables: {},
  },
};

describe("sendWithOutcome", () => {
  it("retries a 429 with the same idempotency key, then succeeds", async () => {
    let calls = 0;
    const keys: string[] = [];

    const fakeSender: EmailSender = async (_payload, options) => {
      calls += 1;
      keys.push(options.idempotencyKey);

      if (calls === 1) {
        return {
          data: null,
          error: {
            name: "rate_limit_exceeded",
            statusCode: 429,
            message: "Rate limited",
          },
          headers: null,
        };
      }

      return {
        data: { id: "fake-message-id" },
        error: null,
        headers: null,
      };
    };

    const result = await sendWithOutcome(payload, "delivery-123", fakeSender);

    expect(result).toEqual({
      status: "success",
      messageId: "fake-message-id",
      attempts: 2,
    });
    expect(keys).toEqual(["delivery-123", "delivery-123"]);
  });

  it("returns a permanent failure for a 400 without retrying", async () => {
    let calls = 0;

    const fakeSender: EmailSender = async () => {
      calls += 1;
      return {
        data: null,
        error: {
          name: "validation_error",
          statusCode: 400,
          message: "Invalid request",
        },
        headers: null,
      };
    };

    const result = await sendWithOutcome(payload, "delivery-456", fakeSender);

    expect(result).toEqual({
      status: "permanent_failure",
      code: "validation_error",
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it("returns unknown after three network failures", async () => {
    let calls = 0;

    const fakeSender: EmailSender = async () => {
      calls += 1;
      throw new Error("Simulated network timeout");
    };

    const result = await sendWithOutcome(payload, "delivery-789", fakeSender);

    expect(result).toEqual({
      status: "unknown",
      code: "network_outcome_unknown",
      attempts: 3,
    });
    expect(calls).toBe(3);
  });
});