import "dotenv/config";
import { sendPriceAlert } from "../src/emails.js";

const recipient = "nickwesterfeld@gmail.com";

const messageId = await sendPriceAlert(recipient, {
  // The title marks this as a test message; the amounts are sample values.
  gameTitle: "Portal 2 [TEST ONLY]",
  currentPriceCents: 999,
  targetPriceCents: 999,
  // Previously returned by CheapShark for Portal 2; this test does not fetch it.
  purchaseUrl:
    "https://www.cheapshark.com/redirect?dealID=rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D",
});

console.log("Price alert test email accepted by Resend. Message ID:", messageId);
