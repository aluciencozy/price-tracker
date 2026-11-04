import "dotenv/config";
import { Resend } from "resend";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);

export async function sendVerificationEmail(
  recipient: string,
  verificationUrl: string,
): Promise<string> {
  const templateId = process.env.RESEND_VERIFICATION_TEMPLATE_ID;
  if (!templateId) {
    throw new Error("RESEND_VERIFICATION_TEMPLATE_ID is not set");
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