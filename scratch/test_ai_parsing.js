require('dotenv').config();
const aiService = require('../src/services/ai.service');

async function testParsing() {
    const from = "testUser";
    
    // Simulate what whatsapp.controller.js does at line 1768
    const text1 = "report for november 2024";
    const filters1 = await aiService.parseReportQuery(text1, from);
    console.log("Raw AI Filters 1:", filters1);

    const text2 = "report for restarurant november 2024";
    const filters2 = await aiService.parseReportQuery(text2, from);
    console.log("Raw AI Filters 2:", filters2);
}

testParsing().catch(console.error);
