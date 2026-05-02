
require('dotenv').config();
const aiService = require('../src/services/ai.service');

async function testExtraction() {
    const testCases = [
        "Is this invoice paid?",
        "How many invoices do I have this month?",
        "How much VAT did I collect?",
        "List my last 5 expenses",
        "Add an expense 50 MAD at Carrefour",
        "Is invoice FAC-00025 paid?",
        "How many unpaid invoices?"
    ];

    console.log('🧪 Testing AI Extraction Logic...\n');

    for (const text of testCases) {
        console.log(`Input: "${text}"`);
        try {
            const result = await aiService.parseReportQuery(text, 'test_user');
            console.log('Result:', JSON.stringify(result, null, 2));
        } catch (err) {
            console.error('Error:', err.message);
        }
        console.log('-------------------\n');
    }
}

testExtraction();
