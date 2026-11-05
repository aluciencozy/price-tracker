import "dotenv/config";
import { Resend } from "resend";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);

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
): Promise<string> {
  requireHttpsUrl(verificationUrl, "Verification URL");
  const templateId = process.env.TEMPLATE_VERIFICATION_EMAIL_ID;
  if (!templateId) {
    throw new Error("TEMPLATE_VERIFICATION_EMAIL_ID is not set");
  }

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    to: recipient,
    template: {
      id: templateId,
      variables: {
        VALIDATION_EMAIL_URL: verificationUrl,
      },
    },
  });

  if (error) {
    throw new Error(`Resend rejected the request: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return a message ID");
  }

  return data.id;
}

export async function sendPasswordReset(
  recipient: string,
  passwordResetURL: string,
): Promise<string> {
  requireHttpsUrl(passwordResetURL, "Password reset URL");
  const templateId = process.env.TEMPLATE_PASSWORD_RESET_ID;
  if (!templateId) {
    throw new Error("TEMPLATE_PASSWORD_RESET_ID is not set");
  }

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    to: recipient,
    template: {
      id: templateId,
      variables: {
        PASSWORD_RESET_URL: passwordResetURL,
      },
    },
  });

  if (error) {
    throw new Error(`Resend rejected the request: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return a message ID");
  }

  return data.id;
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
): Promise<string> {
  if (!alert.gameTitle.trim()) {
    throw new Error("Price alert game title is required");
  }
  if (
    !Number.isSafeInteger(alert.currentPriceCents) ||
    alert.currentPriceCents < 0 ||
    !Number.isSafeInteger(alert.targetPriceCents) ||
    alert.targetPriceCents < 0
  ) {
    throw new Error("Price alert amounts must be nonnegative integer cents");
  }
  if (alert.currentPriceCents > alert.targetPriceCents) {
    throw new Error("Price alert can only be sent when the game qualifies for the target");
  }

  const purchaseUrl = requireHttpsUrl(alert.purchaseUrl, "CheapShark purchase URL");
  if (
    purchaseUrl.hostname !== "www.cheapshark.com" ||
    purchaseUrl.pathname !== "/redirect" ||
    !purchaseUrl.searchParams.has("dealID")
  ) {
    throw new Error("Price alert must use a CheapShark purchase redirect");
  }

  const templateId = process.env.TEMPLATE_PRICE_ALERT_ID;
  if (!templateId) {
    throw new Error("TEMPLATE_PRICE_ALERT_ID is not set");
  }

  const formatUsd = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

  const { data, error } = await resend.emails.send({
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
  });

  if (error) {
    throw new Error(`Resend rejected the request: ${error.message}`);
  }
  if (!data?.id) {
    throw new Error("Resend did not return a message ID");
  }

  return data.id;
}
