
const axios = require('axios');

const baseUrl = 'http://localhost:8000/api';
const phone = '919304220627';

async function test() {
    try {
        console.log('Testing Weekly Report (This Week)...');
        // Apr 27 - May 3
        const response = await axios.get(`${baseUrl}/bot/customer/dashboard-data`, {
            params: {
                date_from: '2026-04-27',
                date_to: '2026-05-03'
            },
            headers: {
                'X-Customer-Phone': phone,
                'X-Bot-Secret': '69c932e7409a99b491c44789314ae787'
            }
        });
        
        const data = response.data.data;
        console.log('Report Data:', JSON.stringify({
            total_expenses_sum: data.total_expenses_sum,
            total_expenses_count: data.total_expenses_count,
            date_from: '2026-04-27',
            date_to: '2026-05-03'
        }, null, 2));

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

test();
