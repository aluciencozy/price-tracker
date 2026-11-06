import "dotenv/config";
import { Resend } from "resend";

let resend: Resend | undefined;

function getResend(): Resend | undefined {
  const apiKey = process.env.RESEND_SEND_API_KEY;
  if (!apiKey) return undefined;
  resend ??= new Resend(apiKey);
  return resend;
}

export type DeliveryOutcome =
  | { status: "success"; messageId: string; attempts: number }
  | { status: "retryable_failure"; code: string; attempts: number; retryAfterMs?: number }
  | { status: "permanent_failure"; code: string; attempts: number }
  | { status: "unknown"; code: string; attempts: number };

function permanentFailure(code: string): DeliveryOutcome {
  return { status: "permanent_failure", code, attempts: 0 };
}

type EmailPayload = Parameters<Resend["emails"]["send"]>[0];
type EmailResponse = Awaited<ReturnType<Resend["emails"]["send"]>>;
export type EmailSender = (
  payload: EmailPayload,
  options: { idempotencyKey: string; signal: AbortSignal },
) => Promise<EmailResponse>;

const MAX_SEND_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 5_000;
const MAX_RETRY_WAIT_MS = 1_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getRetryAfterMs(response: EmailResponse): number | undefined {
  const value = response.headers?.["retry-after"];
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Shared bounded send logic. Tests can pass a fake sender as the third argument. */
export async function sendWithOutcome(
  payload: EmailPayload,
  idempotencyKey: string,
  sender?: EmailSender,
): Promise<DeliveryOutcome> {
  if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
    return { status: "permanent_failure", code: "invalid_idempotency_key", attempts: 0 };
  }

  const client = sender ? undefined : getResend();
  if (!sender && !client) {
    return permanentFailure("resend_api_key_missing");
  }
  const send = sender ?? ((message, options) => client!.emails.send(message, options));

  let uncertain = false;
  for (let attempts = 1; attempts <= MAX_SEND_ATTEMPTS; attempts += 1) {
    let response: EmailResponse;
    try {
      response = await send(payload, {
        idempotencyKey,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      uncertain = true;
      // The provider may have accepted the email before the connection failed.
      // Retry only with this same idempotency key.
      if (attempts < MAX_SEND_ATTEMPTS) {
        await wait(Math.min(200 * 2 ** (attempts - 1), MAX_RETRY_WAIT_MS));
        continue;
      }
      return { status: "unknown", code: "network_outcome_unknown", attempts };
    }

    if (response.data?.id) {
      return { status: "success", messageId: response.data.id, attempts };
    }

    const error = response.error;
    if (!error) {
      return { status: "unknown", code: "provider_response_missing_id", attempts };
    }

    const code = error.name || "provider_error";
    const statusCode = error.statusCode;
    if (statusCode === null) {
      uncertain = true;
      if (attempts < MAX_SEND_ATTEMPTS) {
        await wait(Math.min(200 * 2 ** (attempts - 1), MAX_RETRY_WAIT_MS));
        continue;
      }
      return { status: "unknown", code, attempts };
    }

    const retryable = statusCode === 408 || statusCode === 429 || statusCode >= 500 ||
      code === "concurrent_idempotent_requests";
    if (statusCode === 408 || statusCode >= 500 || code === "concurrent_idempotent_requests") {
      uncertain = true;
    }
    if (!retryable) {
      if (uncertain) return { status: "unknown", code: "prior_outcome_unknown", attempts };
      return { status: "permanent_failure", code, attempts };
    }

    const retryAfterMs = getRetryAfterMs(response);
    if (attempts === MAX_SEND_ATTEMPTS || (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_WAIT_MS)) {
      if (uncertain) return { status: "unknown", code: "prior_outcome_unknown", attempts };
      return { status: "retryable_failure", code, attempts, retryAfterMs };
    }

    await wait(retryAfterMs ?? Math.min(200 * 2 ** (attempts - 1), MAX_RETRY_WAIT_MS));
  }

  return { status: "unknown", code: "attempt_limit_reached", attempts: MAX_SEND_ATTEMPTS };
}

function requireHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }

  return url;
}

export async function sendVerificationEmail(
  recipient: string,
  verificationUrl: string,
  idempotencyKey: string,
): Promise<DeliveryOutcome> {
  if (!recipient.trim()) return permanentFailure("recipient_required");
  try {
    requireHttpsUrl(verificationUrl, "Verification URL");
  } catch {
    return permanentFailure("invalid_verification_url");
  }

  const templateId = process.env.TEMPLATE_VERIFICATION_EMAIL_ID;
  if (!templateId) {
    return permanentFailure("verification_template_id_missing");
  }

  return sendWithOutcome({
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    to: recipient,
    template: {
      id: templateId,
      variables: {
        VALIDATION_EMAIL_URL: verificationUrl,
      },
    },
  }, idempotencyKey);
}

export async function sendPasswordReset(
  recipient: string,
  passwordResetURL: string,
  idempotencyKey: string,
): Promise<DeliveryOutcome> {
  if (!recipient.trim()) return permanentFailure("recipient_required");
  try {
    requireHttpsUrl(passwordResetURL, "Password reset URL");
  } catch {
    return permanentFailure("invalid_password_reset_url");
  }

  const templateId = process.env.TEMPLATE_PASSWORD_RESET_ID;
  if (!templateId) {
    return permanentFailure("password_reset_template_id_missing");
  }

  return sendWithOutcome({
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    to: recipient,
    template: {
      id: templateId,
      variables: {
        PASSWORD_RESET_URL: passwordResetURL,
      },
    },
  }, idempotencyKey);
}

export type PriceAlertEmail = {
  gameTitle: string;
  currentPriceCents: number;
  targetPriceCents: number;
  purchaseUrl: string;
};

export async function sendPriceAlert(
  recipient: string,
  alert: PriceAlertEmail,
  idempotencyKey: string,
): Promise<DeliveryOutcome> {
  if (!recipient.trim()) return permanentFailure("recipient_required");
  if (!alert.gameTitle.trim()) {
    return permanentFailure("game_title_required");
  }
  if (
    !Number.isSafeInteger(alert.currentPriceCents) ||
    alert.currentPriceCents < 0 ||
    !Number.isSafeInteger(alert.targetPriceCents) ||
    alert.targetPriceCents < 0
  ) {
    return permanentFailure("invalid_price_amount");
  }
  if (alert.currentPriceCents > alert.targetPriceCents) {
    return permanentFailure("target_not_qualified");
  }

  let purchaseUrl: URL;
  try {
    purchaseUrl = requireHttpsUrl(alert.purchaseUrl, "CheapShark purchase URL");
  } catch {
    return permanentFailure("invalid_purchase_url");
  }
  if (
    purchaseUrl.hostname !== "www.cheapshark.com" ||
    purchaseUrl.pathname !== "/redirect" ||
    !purchaseUrl.searchParams.get("dealID")
  ) {
    return permanentFailure("invalid_cheapshark_redirect");
  }

  const templateId = process.env.TEMPLATE_PRICE_ALERT_ID;
  if (!templateId) {
    return permanentFailure("price_alert_template_id_missing");
  }

  const formatUsd = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

  return sendWithOutcome({
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    to: recipient,
    template: {
      id: templateId,
      variables: {
        GAME_TITLE: alert.gameTitle,
        CURRENT_PRICE: formatUsd(alert.currentPriceCents),
        TARGET_PRICE: formatUsd(alert.targetPriceCents),
        PURCHASE_URL: purchaseUrl.toString(),
      },
    },
  }, idempotencyKey);
}
