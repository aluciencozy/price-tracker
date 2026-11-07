import "dotenv/config";
import { Resend } from "resend";
import { reserveEmailSend, emailAttemptMayStart, type EmailBudgetDecision } from './emailBudget.js';

/** Only thrown when this invocation made no provider request. Never means an older send was unsent. */
export class EmailSendDeferred extends Error {
  constructor(public readonly retryAfterMs: number) { super('Email send deferred before transport.'); }
}
export type EmailSendBudget = () => Promise<EmailBudgetDecision>;

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
  | { status: "unknown"; code: string; attempts: number; retryAfterMs?: number };

function permanentFailure(code: string): DeliveryOutcome {
  return { status: "permanent_failure", code, attempts: 0 };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
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

  const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isFinite(seconds) && Number.isFinite(seconds * 1_000)) return seconds * 1_000;

  // Do not interpret malformed numeric delays (e.g. "-1") as calendar dates.
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Shared bounded send logic; the optional sender has the same trust boundary as Resend.
 * Resend 6.x exposes response headers, but JSON error.statusCode is only body data:
 * the SDK neither verifies it against HTTP status nor exposes that status separately.
 * There is no scoped transport hook. Never infer a definite provider rejection from
 * that field (or error.name). All unconfirmed sends are unknown, even apparent 4xx.
 * Only local pre-send validation/configuration failures are permanent. The outcome
 * union retains retryable_failure for future transports with verified HTTP evidence.
 */
export async function sendWithOutcome(
  payload: EmailPayload,
  idempotencyKey: string,
  sender?: EmailSender,
  budget?: EmailSendBudget,
): Promise<DeliveryOutcome> {
  if (!idempotencyKey.trim() || idempotencyKey.length > 256) {
    return { status: "permanent_failure", code: "invalid_idempotency_key", attempts: 0 };
  }

  const client = sender ? undefined : getResend();
  if (!sender && !client) {
    return permanentFailure("resend_api_key_missing");
  }
  const send = sender ?? ((message, options) => client!.emails.send(message, options));
  // Injected fake transports may omit the budget for legacy adapter unit tests.
  // Every real transport invocation reserves anew, including same-key reconciliation.
  const decision = await (budget ?? (sender ? async () => undefined : reserveEmailSend))();
  if (decision?.status === 'deferred') throw new EmailSendDeferred(Math.max(1000, decision.retryAfterMs));

  for (let attempts = 1; attempts <= MAX_SEND_ATTEMPTS; attempts += 1) {
    if (decision && !emailAttemptMayStart(decision)) {
      if (attempts === 1) throw new EmailSendDeferred(60_000);
      return { status: 'unknown', code: 'email_budget_deadline_expired', attempts: attempts - 1 };
    }
    let response: EmailResponse;
    try {
      response = await send(payload, {
        idempotencyKey,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // The provider may have accepted the email before the connection failed.
      // Retry only with this same idempotency key.
      if (attempts < MAX_SEND_ATTEMPTS) {
        await wait(Math.min(200 * 2 ** (attempts - 1), MAX_RETRY_WAIT_MS));
        continue;
      }
      return { status: "unknown", code: "network_outcome_unknown", attempts };
    }

    if (!response?.error && typeof response?.data?.id === "string" && response.data.id.trim().length > 0) {
      return { status: "success", messageId: response.data.id, attempts };
    }

    // Headers survive the SDK's JSON-error path and can pace retries. They do
    // not establish non-delivery. Malformed/missing results are uncertain too.
    const retryAfterMs = response ? getRetryAfterMs(response) : undefined;
    if (attempts === MAX_SEND_ATTEMPTS || (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_WAIT_MS)) {
      return {
        status: "unknown",
        code: "provider_outcome_unknown",
        attempts,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
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
        VALIDATION_EMAIL_URL_HTML: escapeHtml(verificationUrl),
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
        PASSWORD_RESET_URL_HTML: escapeHtml(passwordResetURL),
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
        GAME_TITLE_HTML: escapeHtml(alert.gameTitle),
        CURRENT_PRICE: formatUsd(alert.currentPriceCents),
        TARGET_PRICE: formatUsd(alert.targetPriceCents),
        PURCHASE_URL: purchaseUrl.toString(),
        PURCHASE_URL_HTML: escapeHtml(purchaseUrl.toString()),
      },
    },
  }, idempotencyKey);
}
