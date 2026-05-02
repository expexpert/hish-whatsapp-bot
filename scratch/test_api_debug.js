const axios = require('axios');
require('dotenv').config();

async function testApi() {
    const phone = '919304220627';
    const baseUrl = 'http://localhost:8000/api/bot';
    const secret = process.env.WHATSAPP_BOT_SECRET;

    try {
        console.log('📡 Calling Local API for Dashboard Data...');
        const response = await axios.get(`${baseUrl}/customer/dashboard-data`, {
            params: {
                date_from: '2026-05-01',
                date_to: '2026-05-31'
            },
            headers: {
                'X-Bot-Secret': secret,
                'X-Customer-Phone': phone,
                'Accept': 'application/json'
            }
        });

        console.log('✅ RAW DATA RECEIVED:');
        console.log(JSON.stringify(response.data.data, null, 2));
        
        const data = response.data.data;
        const vatCollected = parseFloat(data.vat_collected) || 0;
        const totalVatPayable = parseFloat(data.total_vat_payable) || 0;
        
        console.log('\n--- VERIFICATION ---');
        console.log(`VAT Collected (Sales): ${vatCollected}`);
        console.log(`VAT Payable (Net): ${totalVatPayable}`);
        
    } catch (error) {
        console.error('❌ API Error:', error.response?.data || error.message);
    }
}

testApi();
