import { passwordResetTemplate } from "../src/testTemplateMail.js";

const templateId = await passwordResetTemplate();
console.log("Save this password reset template ID in API configuration:", templateId);
