const dotenv = require('dotenv');
dotenv.config();

const whatsappController = require('../src/controllers/whatsapp.controller');
const stateService = require('../src/services/state.service');
const logger = require('../src/utils/logger');

// Mock WhatsApp Service to capture output
const whatsappService = require('../src/services/whatsapp.service');
whatsappService.sendTextMessage = async (from, text) => {
    console.log(`\n📤 [BOT RESPONSE to ${from}]:`);
    console.log(`-----------------------------------`);
    console.log(text);
    console.log(`-----------------------------------`);
    return { success: true };
};

whatsappService.sendInteractiveList = async (from, body) => {
    console.log(`\n📤 [BOT LIST to ${from}]: ${body}`);
    return { success: true };
};

async function testSearchByName() {
    const testPhone = '919304220627';
    
    console.log('🚀 Starting Search by Name Test...');

    try {
        // 1. Manually set state to AWAITING_REPORT_SEARCH (simulating button click)
        await stateService.setUserState(testPhone, 'AWAITING_REPORT_SEARCH');
        console.log('\n📥 [USER MESSAGE]: "Sagar"');
        
        // 2. Process message
        await whatsappController.processMessage({
            from: testPhone,
            type: 'text',
            text: { body: 'Sagar' }
        });

    } catch (err) {
        console.error('❌ TEST FAILED:', err);
    }
}

testSearchByName();
