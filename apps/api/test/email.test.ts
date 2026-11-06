import { describe, expect, it } from "vitest";
import { sendPriceAlert, sendWithOutcome, type EmailSender } from "../src/emails.js";

const payload = {
  from: "test@example.com",
  to: "test@example.com",
  template: {
    id: "fake-template-id",
    variables: {},
  },
};

type StubRequest = { url: string; idempotencyKey: string | null; body: string };

async function withResendFetchStub(
  fetchStub: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.RESEND_SEND_API_KEY;
  process.env.RESEND_SEND_API_KEY = "re_test_offline_stub";
  globalThis.fetch = fetchStub;

  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.RESEND_SEND_API_KEY;
    else process.env.RESEND_SEND_API_KEY = previousApiKey;
  }
}

function recordRequest(input: RequestInfo | URL, init?: RequestInit): StubRequest {
  return {
    url: String(input),
    idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
    body: String(init?.body ?? ""),
  };
}

describe("sendWithOutcome", () => {
  it.each([403, 429, 500])("preserves an uncertain send before a later %i", async (statusCode) => {
    let calls = 0;
    const fakeSender: EmailSender = async () => {
      if (++calls === 1) throw new Error("timeout");
      return { data: null, error: { name: "validation_error", statusCode, message: "failure" }, headers: { "retry-after": "10" } };
    };
    expect(await sendWithOutcome(payload, "delivery-uncertain", fakeSender)).toMatchObject({ status: "unknown" });
  });

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

  it.each([undefined, null, "403", Number.NaN, Number.POSITIVE_INFINITY, 399, 600, 403.5])(
    "does not treat an invalid provider status (%s) as a permanent failure",
    async (statusCode) => {
      let calls = 0;
      const keys: string[] = [];
      const fakeSender: EmailSender = async (_payload, options) => {
        calls += 1;
        keys.push(options.idempotencyKey);
        if (calls === 1) {
          return {
            data: null,
            error: {
              name: "validation_error",
              statusCode: statusCode as number,
              message: "Untrusted provider status",
            },
            headers: null,
          };
        }
        return { data: { id: "fake-message-id" }, error: null, headers: null };
      };

      const result = await sendWithOutcome(payload, "same-key-invalid-status", fakeSender);

      expect(result).toEqual({ status: "success", messageId: "fake-message-id", attempts: 2 });
      expect(calls).toBe(2);
      expect(keys).toEqual(["same-key-invalid-status", "same-key-invalid-status"]);
    },
  );

  it("uses the actual Resend SDK and keeps a missing-status 503 uncertain across a later failure", async () => {
    const requests: StubRequest[] = [];
    const responses = [
      new Response(JSON.stringify({ name: "upstream_error", message: "Temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({
        name: "validation_error",
        statusCode: 403,
        message: "Later attempt rejected",
      }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra Resend request");
      return response;
    }) as typeof fetch;

    await withResendFetchStub(fetchStub, async () => {
      const result = await sendWithOutcome(payload, "sdk-uncertain-key");

      expect(result).toEqual({ status: "unknown", code: "prior_outcome_unknown", attempts: 2 });
    });

    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url === "https://api.resend.com/emails")).toBe(true);
    expect(requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "sdk-uncertain-key",
      "sdk-uncertain-key",
    ]);
  });

  it("keeps malformed Resend error responses unknown after the bounded same-key retries", async () => {
    const requests: StubRequest[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response("not valid JSON", {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await withResendFetchStub(fetchStub, async () => {
      const result = await sendWithOutcome(payload, "sdk-malformed-key");

      expect(result).toEqual({ status: "unknown", code: "prior_outcome_unknown", attempts: 3 });
    });

    expect(requests).toHaveLength(3);
    expect(requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "sdk-malformed-key",
      "sdk-malformed-key",
      "sdk-malformed-key",
    ]);
  });

  it("sends documented template variables with explicit HTML-context escaping", async () => {
    const requests: StubRequest[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(JSON.stringify({ id: "fake-message-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const previousTemplateId = process.env.TEMPLATE_PRICE_ALERT_ID;
    process.env.TEMPLATE_PRICE_ALERT_ID = "offline-template-id";

    try {
      await withResendFetchStub(fetchStub, async () => {
        const result = await sendPriceAlert("test@example.com", {
          gameTitle: `<Portal & "A" 'B'>`,
          currentPriceCents: 499,
          targetPriceCents: 500,
          purchaseUrl: "https://www.cheapshark.com/redirect?dealID=offer&campaign=test",
        }, "template-escaping-key");

        expect(result).toEqual({ status: "success", messageId: "fake-message-id", attempts: 1 });
      });
    } finally {
      if (previousTemplateId === undefined) delete process.env.TEMPLATE_PRICE_ALERT_ID;
      else process.env.TEMPLATE_PRICE_ALERT_ID = previousTemplateId;
    }

    expect(requests).toHaveLength(1);
    const sent = JSON.parse(requests[0]!.body) as {
      template: { id: string; variables: Record<string, string> };
    };
    expect(sent.template).toEqual({
      id: "offline-template-id",
      variables: {
        GAME_TITLE: `<Portal & "A" 'B'>`,
        GAME_TITLE_HTML: "&lt;Portal &amp; &quot;A&quot; &#39;B&#39;&gt;",
        CURRENT_PRICE: "$4.99",
        TARGET_PRICE: "$5.00",
        PURCHASE_URL: "https://www.cheapshark.com/redirect?dealID=offer&campaign=test",
        PURCHASE_URL_HTML: "https://www.cheapshark.com/redirect?dealID=offer&amp;campaign=test",
      },
    });
  });
});
