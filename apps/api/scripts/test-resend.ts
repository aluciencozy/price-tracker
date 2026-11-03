import "dotenv/config";
import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) throw new Error("RESEND_API_KEY is not set");

const resend = new Resend(apiKey);

const { data, error } = await resend.emails.send({
  from: "onboarding@resend.dev",
  to: "nickwesterfeld@gmail.com",
  subject: "Price Tracker email test",
  html: "<p>This is a test email from Price Tracker.</p>",
  // Replace with an address you monitor, or remove this field.
  replyTo: "nickwesterfeld@gmail.com",
});

if (error) {
  console.error("Resend rejected the request:", error.message);
  process.exitCode = 1;
} else {
  console.log("Accepted by Resend. Message ID:", data?.id);
}