import {validationEmailTemplate} from "../src/testTemplateMail.js"

const templateId = await validationEmailTemplate();
console.log("Save this template ID in API configuration:", templateId);