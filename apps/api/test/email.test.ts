import { describe, expect, it } from "vitest";
import { sendPasswordReset, sendPriceAlert, sendVerificationEmail, sendWithOutcome, type EmailSender } from "../src/emails.js";

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
  it("keeps local pre-send validation permanent without calling the transport", async () => {
    let calls = 0;
    const fakeSender: EmailSender = async () => {
      calls++;
      throw new Error("must not send");
    };
    expect(await sendWithOutcome(payload, " ", fakeSender)).toEqual({
      status: "permanent_failure", code: "invalid_idempotency_key", attempts: 0,
    });
    expect(calls).toBe(0);
  });

  it.each([
    [503, { statusCode: 429, name: "rate_limit_exceeded" }],
    [503, { statusCode: 400, name: "validation_error" }],
    [503, { statusCode: 403, name: "validation_error" }],
    [503, { name: "upstream_error" }],
    [503, { statusCode: null }],
    [503, { statusCode: "429" }],
    [503, { statusCode: 403.5 }],
    [503, { statusCode: 600 }],
    [503, { statusCode: 503 }],
    [400, { statusCode: 400, name: "validation_error" }],
    [429, { statusCode: 429, name: "rate_limit_exceeded" }],
    [503, null],
    [503, []],
    [503, "failure"],
    [503, { id: "not-a-success-on-error-path" }],
    [200, {}],
    [200, { id: 123 }],
    [200, { id: "   " }],
  ])("keeps actual SDK HTTP %i / body %j unknown with bounded same-key retries", async (httpStatus, body) => {
    const requests: StubRequest[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(JSON.stringify(body), {
        status: httpStatus,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }) as typeof fetch;

    await withResendFetchStub(fetchStub, async () => {
      expect(await sendWithOutcome(payload, "sdk-body-is-not-evidence")).toEqual({
        status: "unknown", code: "provider_outcome_unknown", attempts: 3, retryAfterMs: 0,
      });
    });
    expect(requests).toHaveLength(3);
    expect(requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual(Array(3).fill("sdk-body-is-not-evidence"));
    expect(new Set(requests.map(({ body }) => body)).size).toBe(1);
  });

  it.each([429, 400, 403])("respects real Retry-After on contradictory HTTP 503 / body %i", async (bodyStatus) => {
    const requests: StubRequest[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(JSON.stringify({ statusCode: bodyStatus, name: "validation_error" }), {
        status: 503, headers: { "retry-after": "10" },
      });
    }) as typeof fetch;
    await withResendFetchStub(fetchStub, async () => {
      expect(await sendWithOutcome(payload, "sdk-long-delay")).toEqual({
        status: "unknown", code: "provider_outcome_unknown", attempts: 1, retryAfterMs: 10000,
      });
    });
    expect(requests).toHaveLength(1);
  });

  it.each([400, 429, 200])("preserves contradictory-status uncertainty across a later HTTP %i, unless success is confirmed", async (laterStatus) => {
    const requests: StubRequest[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      const first = requests.length === 1;
      return new Response(JSON.stringify(first
        ? { statusCode: 400, name: "validation_error" }
        : laterStatus === 200 ? { id: "confirmed-message" } : { statusCode: laterStatus, name: "validation_error" }), {
        status: first ? 503 : laterStatus,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;
    await withResendFetchStub(fetchStub, async () => {
      const outcome = await sendWithOutcome(payload, "sdk-sequence");
      expect(outcome).toEqual(laterStatus === 200
        ? { status: "success", messageId: "confirmed-message", attempts: 2 }
        : { status: "unknown", code: "provider_outcome_unknown", attempts: 3, retryAfterMs: 0 });
    });
    expect(requests).toHaveLength(laterStatus === 200 ? 2 : 3);
    expect(requests.every(({ idempotencyKey }) => idempotencyKey === "sdk-sequence")).toBe(true);
  });

  it.each(["garbage", "-1", "1.5"])("ignores malformed Retry-After %s without trusting body status", async (retryAfter) => {
    let calls = 0;
    const fakeSender: EmailSender = async () => {
      calls++;
      return { data: null, error: { name: "validation_error", statusCode: 400, message: "failure" }, headers: { "retry-after": retryAfter } };
    };
    expect(await sendWithOutcome(payload, "bad-delay", fakeSender)).toEqual({
      status: "unknown", code: "provider_outcome_unknown", attempts: 3,
    });
    expect(calls).toBe(3);
  });

  it("preserves a real HTTP-date Retry-After without waiting past the call's bound", async () => {
    const retryDate = new Date(Date.now() + 60_000).toUTCString();
    let calls = 0;
    await withResendFetchStub((async () => {
      calls++;
      return new Response("not JSON", { status: 503, headers: { "retry-after": retryDate } });
    }) as typeof fetch, async () => {
      const outcome = await sendWithOutcome(payload, "sdk-date-delay");
      expect(outcome).toMatchObject({ status: "unknown", attempts: 1 });
      expect("retryAfterMs" in outcome && outcome.retryAfterMs).toBeGreaterThan(50_000);
    });
    expect(calls).toBe(1);
  });

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

  it("does not trust a sender's body-only 400 as a definite rejection", async () => {
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
      status: "unknown",
      code: "provider_outcome_unknown",
      attempts: 3,
    });
    expect(calls).toBe(3);
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
      new Response(JSON.stringify({ name: "rate_limit_exceeded", statusCode: 429 }), {
        status: 429,
        headers: { "retry-after": "10" },
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

      expect(result).toEqual({ status: "unknown", code: "provider_outcome_unknown", attempts: 3, retryAfterMs: 10000 });
    });

    expect(requests).toHaveLength(3);
    expect(requests.every(({ url }) => url === "https://api.resend.com/emails")).toBe(true);
    expect(requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "sdk-uncertain-key",
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

      expect(result).toEqual({ status: "unknown", code: "provider_outcome_unknown", attempts: 3 });
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

  it.each([
    [sendVerificationEmail, "TEMPLATE_VERIFICATION_EMAIL_ID", "VALIDATION_EMAIL_URL"],
    [sendPasswordReset, "TEMPLATE_PASSWORD_RESET_ID", "PASSWORD_RESET_URL"],
  ] as const)("escapes HTML account-link variables separately from plain text (%s)", async (send, setting, variable) => {
    const requests: StubRequest[] = [];
    const previous = process.env[setting];
    process.env[setting] = "offline-account-template";
    const url = 'https://tracker.example/verify#token=offline&test="value"';
    try {
      await withResendFetchStub((async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(recordRequest(input, init));
        return new Response(JSON.stringify({ id: "account-message" }), { status: 200 });
      }) as typeof fetch, async () => {
        expect(await send("test@example.com", url, "account-template-key")).toMatchObject({ status: "success" });
      });
    } finally {
      if (previous === undefined) delete process.env[setting];
      else process.env[setting] = previous;
    }
    expect(requests).toHaveLength(1);
    const sent = JSON.parse(requests[0]!.body) as { template: { variables: Record<string, string> } };
    expect(sent.template.variables).toEqual({
      [variable]: url,
      [`${variable}_HTML`]: "https://tracker.example/verify#token=offline&amp;test=&quot;value&quot;",
    });
  });
});
