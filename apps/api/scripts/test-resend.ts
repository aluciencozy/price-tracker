import "dotenv/config";
import { Resend } from "resend";
import {testEmail} from "../src/testTemplateMail.js";
import { sendVerificationEmail, sendPasswordReset} from "../src/emails.js";
import {passwordResetTemplate} from "../src/testTemplateMail.js";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);
/*
const templateId = await passwordResetTemplate();
console.log("Password reset template ID:", templateId);
*/

await sendPasswordReset(
  "nickwesterfeld@gmail.com",
  "https://webcourses.ucf.edu"
)

/*await sendVerificationEmail(
  "nickwesterfeld@gmail.com",
  "https://www.youtube.com/watch?v=r9X4BQkCqUw",
);*/