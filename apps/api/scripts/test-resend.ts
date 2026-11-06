import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sendPriceAlert } from "../src/emails.js";

const recipient = process.env.RESEND_TEST_RECIPIENT;
if (!recipient) throw new Error("RESEND_TEST_RECIPIENT is not set");

const outcome = await sendPriceAlert(recipient, {
  // The title marks this as a test message; the amounts are sample values.
  gameTitle: "Portal 2 [TEST ONLY]",
  currentPriceCents: 999,
  targetPriceCents: 999,
  // Previously returned by CheapShark for Portal 2; this test does not fetch it.
  purchaseUrl:
    "https://www.cheapshark.com/redirect?dealID=rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D",
}, `price-alert-test:${randomUUID()}`);

if (outcome.status === "success") {
  console.log("Price alert test email accepted by Resend. Message ID:", outcome.messageId);
} else {
  console.error("Price alert test outcome:", outcome.status, outcome.code);
  process.exitCode = outcome.status === "retryable_failure" ? 2 : 1;
}
