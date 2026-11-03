import "dotenv/config";
import { Resend } from "resend";
import {testEmail} from "../src/mail.js";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) throw new Error("RESEND_API_KEY is not set");

const resend = new Resend(apiKey);

await testEmail();