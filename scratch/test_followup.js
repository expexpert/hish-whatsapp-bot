
const axios = require('axios');

const phone = '919304220627';

async function test() {
    try {
        console.log('Step 1: Asking "Is VAT applied on #INVO00032?"...');
        await axios.post('http://localhost:3005/api/whatsapp/webhook', {
            object: "whatsapp_business_account",
            entry: [{
                changes: [{
                    value: {
                        messaging_product: "whatsapp",
                        messages: [{
                            from: phone,
                            id: "test_msg_vat_1_" + Date.now(),
                            text: { body: "Is VAT applied on #INVO00032?" },
                            type: "text"
                        }]
                    },
                    field: "messages"
                }]
            }]
        });

        console.log('Test sent. Check server logs.');

    } catch (error) {
        console.error('Error:', error.message);
    }
}

test();
