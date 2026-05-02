
require('dotenv').config();
const path = require('path');

// 1. Force Local Backend for testing
process.env.ACTIVE_PHP_BACKEND = 'local';
process.env.LARAVEL_LOCAL_API_URL = 'http://localhost:8000/api';

const whatsappController = require('../src/controllers/whatsapp.controller');
const whatsappService = require('../src/services/whatsapp.service');
const stateService = require('../src/services/state.service');
const laravelService = require('../src/services/laravel.service');

// 2. Mock WhatsApp Service to capture output instead of sending to Meta
let lastResponse = null;
whatsappService.sendTextMessage = async (from, text) => {
    console.log(`\n📤 [BOT RESPONSE to ${from}]:`);
    console.log(`-----------------------------------`);
    console.log(text);
    console.log(`-----------------------------------\n`);
    lastResponse = text;
    return { success: true };
};

// 3. Helper to simulate a message
async function simulateMessage(phone, text) {
    console.log(`\n📥 [USER MESSAGE from ${phone}]: "${text}"`);
    const mockMessage = {
        from: phone,
        type: 'text',
        id: 'msg_' + Date.now(),
        text: { body: text }
    };
    await whatsappController.processMessage(mockMessage);
}

// 4. Test Suite
async function runTest() {
    const testPhone = '919304220627';
    
    console.log('🚀 Starting AI Logic Test (BIT/INTEGER/DECIMAL)...');
    console.log(`📡 Backend: ${laravelService.baseUrl}`);

    try {
        // --- Scenario 1: Ambiguous Yes/No ---
        console.log('\n--- Scenario 1: Ambiguous Yes/No ---');
        await simulateMessage(testPhone, 'Is this invoice paid?');

        // --- Scenario 2: INTEGER Count ---
        console.log('\n--- Scenario 2: INTEGER Count ---');
        await simulateMessage(testPhone, 'How many invoices do I have this month?');

        // --- Scenario 3: DECIMAL Financial ---
        console.log('\n--- Scenario 3: DECIMAL Financial ---');
        await simulateMessage(testPhone, 'How much VAT did I collect?');

        // --- Scenario 4: Specific Record Yes/No (Real Paid Invoice) ---
        console.log('\n--- Scenario 4: Specific Record Yes/No (Real Paid Invoice) ---');
        await simulateMessage(testPhone, 'Is invoice FAC-TEST-PAID-777 paid?');

        // --- Scenario 5: Context-Aware Follow-up ---
        console.log('\n--- Scenario 5: Context-Aware Follow-up ---');
        await simulateMessage(testPhone, 'I spent 50 MAD at Shell today');
        console.log('...Waiting for context to settle...');
        await simulateMessage(testPhone, 'Is it paid?');

        console.log('\n✅ Test execution completed.');
    } catch (err) {
        console.error('\n❌ Test failed with error:', err.message);
    }
}

runTest();
