import "dotenv/config";
import { Resend } from "resend";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);

export async function sendVerificationEmail(
  recipient: string,
  verificationUrl: string,
): Promise<string> {
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