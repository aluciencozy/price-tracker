import "dotenv/config";
import { Resend } from "resend";

const apiKey = process.env.RESEND_SEND_API_KEY;
if (!apiKey) throw new Error("RESEND_SEND_API_KEY is not set");

const resend = new Resend(apiKey);

const fullAPIKey = process.env.RESEND_FULL_ACCESS_API_KEY;
if(!fullAPIKey) throw new Error("RESEND_FULL_ACCESS_API_KEY is not set");


const fullResend = new Resend(fullAPIKey)

export async function testEmail(): Promise<string> {
  const { data, error } = await resend.emails.send({
    from: "onboarding@resend.dev",
    to: process.env.RESEND_TEST_RECIPIENT ?? (() => { throw new Error("RESEND_TEST_RECIPIENT is not set"); })(),
    subject: "Price Tracker email test",
    html: "<p>This is a test email from Price Tracker.</p>",
  });

  if (error) {
    throw new Error(`Resend rejected the request: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return a message ID.");
  }

  return data.id;
}

// ONLY NEEDS TO BE RUN ONCE
// IF .env CONTAINS THIS TEMPLATE ID ALREADY DO NOT RUN!!!
export async function validationEmailTemplate( ): Promise<string>{
    const { data, error } = await fullResend.templates.create({
    name: 'verification-email',
    subject: "Verify your Price Tracker Account",
        html: '<p><a href="{{{VALIDATION_EMAIL_URL_HTML}}}">Verify your email</a></p>',
        text: 'Verify your email: {{{VALIDATION_EMAIL_URL}}}',
        variables: [
            {
                key: "VALIDATION_EMAIL_URL",
                type: "string",
            },
            {
                key: "VALIDATION_EMAIL_URL_HTML",
                type: "string",
            },
        ],
    });

    if (error) {
        throw new Error(`Could not create template: ${error.message}`);
    }

    if (!data){
        throw new Error("Resend did not return a template.");
    }

    const { error: publishError } = await fullResend.templates.publish(data.id);

    if(publishError){
        throw new Error(`Could not publish template: ${publishError.message}`);
    }

    return data.id;
}

export async function passwordResetTemplate( ): Promise<string>{
    const { data, error } = await fullResend.templates.create({
    name: 'password-reset',
    subject: "Price Tracker Password Reset",
        html: '<p><a href="{{{PASSWORD_RESET_URL_HTML}}}">Reset your password</a></p>',
        text: 'Reset your password: {{{PASSWORD_RESET_URL}}}',
        variables: [
            {
                key: "PASSWORD_RESET_URL",
                type: "string",
            },
            {
                key: "PASSWORD_RESET_URL_HTML",
                type: "string",
            },
        ],
    });

    if (error) {
        throw new Error(`Could not create template: ${error.message}`);
    }

    if (!data){
        throw new Error("Resend did not return a template.");
    }

    const { error: publishError } = await fullResend.templates.publish(data.id);

    if(publishError){
        throw new Error(`Could not publish template: ${publishError.message}`);
    }

    return data.id;
}

export async function priceAlertTemplate(): Promise<string> {
  const { data, error } = await fullResend.templates.create({
    name: "price-alert",
    subject: "A Steam game qualifies for your Price Tracker target",
    html: [
      "<p>The latest successful check found <strong>{{{GAME_TITLE_HTML}}}</strong> on Steam at {{{CURRENT_PRICE}}}.</p>",
      "<p>That qualifies for your target of {{{TARGET_PRICE}}}.</p>",
      '<p><a href="{{{PURCHASE_URL_HTML}}}">View the Steam offer</a> via CheapShark.</p>',
    ].join(""),
    text: "The latest successful check found {{{GAME_TITLE}}} on Steam at {{{CURRENT_PRICE}}}. This qualifies for your target of {{{TARGET_PRICE}}}. View the Steam offer: {{{PURCHASE_URL}}}",
    variables: [
      { key: "GAME_TITLE", type: "string" },
      { key: "GAME_TITLE_HTML", type: "string" },
      { key: "CURRENT_PRICE", type: "string" },
      { key: "TARGET_PRICE", type: "string" },
      { key: "PURCHASE_URL", type: "string" },
      { key: "PURCHASE_URL_HTML", type: "string" },
    ],
  });

  if (error) throw new Error(`Could not create template: ${error.message}`);
  if (!data) throw new Error("Resend did not return a template.");

  const { error: publishError } = await fullResend.templates.publish(data.id);
  if (publishError) {
    throw new Error(`Could not publish template: ${publishError.message}`);
  }

  return data.id;
}
