import { Resend } from 'resend';

const resend = new Resend('');


const { data } = await resend.emails.send({
  from: 'onboarding@resend.dev',
  to: 'nickwesterfeld@gmail.com',
  replyTo: 'you@example.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
});

console.log(`Email  with custom HTML content has been sent.`);
