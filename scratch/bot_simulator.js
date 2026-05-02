/**
 * INTEGRATION SIMULATOR
 * This script simulates the WhatsApp bot flow by mocking the WABA API
 * and calling the processMessage logic directly.
 */

const WhatsAppController = require('../src/controllers/whatsapp.controller');
const whatsappService = require('../src/services/whatsapp.service');
const aiService = require('../src/services/ai.service');
const laravelService = require('../src/services/laravel.service');
const stateService = require('../src/services/state.service');
const storageService = require('../src/services/storage.service');

// Constants
const TEST_PHONE = '9101111222';

// 1. Mock WhatsApp Service to capture outgoing messages instead of sending them
const sentMessages = [];
whatsappService.sendTextMessage = async (to, text) => {
    console.log(`\n[BOT -> ${to}] (Text): ${text}`);
    sentMessages.push({ to, type: 'text', text });
};

whatsappService.sendListMessage = async (to, title, body, buttonLabel, sections) => {
    const sectionSummary = sections.map(s => `${s.title}: ${s.rows.map(r => r.title).join(', ')}`).join('\n');
    console.log(`\n[BOT -> ${to}] (List): ${title}\n${body}\n[${buttonLabel}]\n${sectionSummary}`);
    sentMessages.push({ to, type: 'list', title, body, sections });
};

whatsappService.sendButtonsMessage = async (to, text, buttons) => {
    console.log(`\n[BOT -> ${to}] (Buttons): ${text} [${buttons.map(b => b.title).join('|')}]`);
    sentMessages.push({ to, type: 'buttons', text, buttons });
};

// 2. Initialize Controller
const controller = require('../src/controllers/whatsapp.controller');

async function simulateMessage(text) {
    console.log(`\n[USER -> BOT]: ${text}`);
    const message = {
        id: 'msg_' + Date.now(),
        from: TEST_PHONE,
        type: 'text',
        text: { body: text },
        timestamp: Math.floor(Date.now() / 1000)
    };
    
    // We bypass the webhook wrapper and call processMessage directly
    // Note: processMessage is private/internal but we can access it if it's on the prototype
    await controller.processMessage(message);
}

async function runScenarios() {
    console.log("🚀 STARTING INTEGRATION SCENARIOS\n");

    try {
        // --- SCENARIO 1: Basic Invoice with Missing Product ---
        console.log("--- SCENARIO 1: BASIC INVOICE (NEEDS PRODUCT) ---");
        // Clear state first
        await stateService.clearUserState(TEST_PHONE);
        
        await simulateMessage("Invoice for Client Alpha for 500");
        
        // Assert: We should be in AWAITING_INVOICE_PRODUCT state
        let state = await stateService.getUserState(TEST_PHONE);
        console.log(`RESULT: State is ${state?.step}. Expected: AWAITING_INVOICE_PRODUCT`);

        // Simulate selected product from list
        if (state?.step === 'AWAITING_INVOICE_PRODUCT') {
            const products = state.data.products || [];
            if (products.length > 0) {
                const firstProduct = products[0];
                await simulateMessage(firstProduct.name);
                state = await stateService.getUserState(TEST_PHONE);
                console.log(`RESULT: After product selection, state is ${state?.step}. Expected: INVOICE_CONFIRMATION`);
            }
        }

        // --- SCENARIO 2: Expense with Ambiguous Category ---
        console.log("\n--- SCENARIO 2: EXPENSE (AMBIGUOUS CATEGORY) ---");
        await stateService.clearUserState(TEST_PHONE);
        await simulateMessage("Expense 100 for office"); 
        // Note: My DB has "Office Supplies" and "Office Rent".
        state = await stateService.getUserState(TEST_PHONE);
        console.log(`RESULT: State is ${state?.step}. Expected: AWAITING_EXPENSE_CATEGORY`);

        // --- SCENARIO 3: Language Switching ---
        console.log("\n--- SCENARIO 3: BILINGUAL SWITCH ---");
        await stateService.clearUserState(TEST_PHONE);
        await simulateMessage("Hello");
        await simulateMessage("Bonjour");
        state = await stateService.getUserState(TEST_PHONE);
        console.log(`RESULT: Lang is ${state?.lang}. Expected: fr`);

    } catch (err) {
        console.error("❌ SCENARIO FAILED:", err);
    }
    
    console.log("\n✅ SCENARIOS COMPLETED");
    process.exit(0);
}

runScenarios();
