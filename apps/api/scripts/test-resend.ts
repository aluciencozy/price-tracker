import "dotenv/config";
import { Resend } from "resend";
import {testEmail} from "../src/testTemplateMail.js";
import { sendVerificationEmail} from "../src/emails.js";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);

await sendVerificationEmail(
  "nickwesterfeld@gmail.com",
  "https://www.youtube.com/watch?v=r9X4BQkCqUw",
);