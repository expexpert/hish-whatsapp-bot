const whatsappController = require('../controllers/whatsapp.controller');
const whatsappService = require('../services/whatsapp.service');
const laravelService = require('../services/laravel.service');
const stateService = require('../services/state.service');
const i18n = require('../utils/i18n');

// Mocking WhatsApp Service
whatsappService.sendTextMessage = async (to, text) => {
    console.log(`\n[OUTBOUND TEXT to ${to}]:\n${text}\n-------------------`);
    return { status: 'mock_sent' };
};

whatsappService.sendInteractiveButtons = async (to, body, buttons) => {
    console.log(`\n[OUTBOUND BUTTONS to ${to}]:\nBODY: ${body}\nBUTTONS: ${JSON.stringify(buttons, null, 2)}\n-------------------`);
    return { status: 'mock_sent' };
};

whatsappService.sendInteractiveList = async (to, body, trigger, sections) => {
    console.log(`\n[OUTBOUND LIST to ${to}]:\nBODY: ${body}\nLIST TRIGGER: ${trigger}\nSECTIONS: ${JSON.stringify(sections, null, 2)}\n-------------------`);
    return { status: 'mock_sent' };
};

// Mocking Laravel Service
laravelService.checkAiStatus = async () => ({ allowed: true });
laravelService.logAiUsage = async () => ({ status: 'success' });
laravelService.checkAuth = async () => true; 
laravelService.getClients = async () => [{ id: 1, client_name: 'Client ABC', company_name: 'ABC Corp' }];
laravelService.getSuppliers = async () => [{ id: 1, name: 'Shell' }];
laravelService.getAccountStatus = async () => ({
    salesSum: 5000,
    expensesSum: 2000,
    vatPayable: 300,
    invoicesCount: 5,
    pendingReviewCount: 1,
    month: 'April 2026',
    currency: 'MAD'
});

async function simulateMessage(from, content, type = 'text') {
    const message = {
        from: from,
        id: 'msg_' + Math.random().toString(36).substr(2, 9),
        type: type
    };

    if (type === 'text') {
        console.log(`\n>>> [INBOUND TEXT from ${from}]: "${content}"`);
        message.text = { body: content };
    } else if (type === 'interactive') {
        const id = content.button_reply?.id || content.list_reply?.id;
        const title = content.button_reply?.title || content.list_reply?.title;
        console.log(`\n>>> [INBOUND INTERACTIVE from ${from}]: ID="${id}" TITLE="${title}"`);
        message.interactive = {
            type: content.button_reply ? 'button_reply' : 'list_reply',
            button_reply: content.button_reply,
            list_reply: content.list_reply
        };
    }

    try {
        await whatsappController.processMessage(message);
    } catch (err) {
        console.error('Simulation Error:', err);
    }
}

async function runTests() {
    const testUser = '212600000000';
    await stateService.clearUserState(testUser);

    console.log('=== STARTING BOT FLOW TESTS ===');

    // TEST 1: Greeting in English
    await simulateMessage(testUser, 'Hi');

    // TEST 2: French Intent Detection
    await simulateMessage(testUser, 'Bonjour, je veux enregistrer une dépense de 150 MAD chez Shell');

    // TEST 3: Status Check (Localized)
    await simulateMessage(testUser, 'Statut de mon compte');

    // TEST 4: Invoice Flow (English) - Verifying No Draft
    await simulateMessage(testUser, 'Invoice Microsoft 1000 USD');

    // TEST 5: Interactive Disambiguation (Simulate picking a client)
    // First, trigger a disambiguation
    await simulateMessage(testUser, 'Report for Client');
    
    // Simulate clicking "Client: Client ABC" (assuming id from logic)
    await simulateMessage(testUser, { 
        button_reply: { id: 'rep_c_1', title: 'Client: Client ABC' } 
    }, 'interactive');

    console.log('\n=== TESTS COMPLETE ===');
}

runTests().catch(console.error);
