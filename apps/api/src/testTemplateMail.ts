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
    to: "nickwesterfeld@gmail.com",
    subject: "Price Tracker email test",
    html: "<p>This is a test email from Price Tracker.</p>",
    replyTo: "nickwesterfeld@gmail.com",
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
        html: '<p><a href="{{{VALIDATION_EMAIL_URL}}}">Verify your email</a></p>',
        variables: [
            {
                key: "VALIDATION_EMAIL_URL",
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

    const{error: publishError } = await
    fullResend.templates.publish(data.id);

    if(publishError){
        throw new Error(`Could not publish template: ${publishError.message}`);
    }

    return data.id;
}

