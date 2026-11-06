import { priceAlertTemplate } from "../src/testTemplateMail.js";

const templateId = await priceAlertTemplate();
console.log("Save this price alert template ID in API configuration:", templateId);
