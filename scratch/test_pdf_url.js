const axios = require('axios');

const url = 'https://loura-dismal-electrovalently.ngrok-free.dev/api/bot/invoice/pdf/14?customer_id=1&expires=1776604978&signature=0a5234976bf0d65b9b9596dd6ad11d9402cd1f6f8b5aba8f2c624ca49dd04555';

async function test() {
    try {
        console.log(`Testing URL: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/pdf,application/json'
            }
        });
        console.log(`Status: ${response.status}`);
        console.log(`Content-Type: ${response.headers['content-type']}`);
        console.log(`Body (first 100 bytes): ${response.data.substring(0, 100)}`);
    } catch (error) {
        console.log(`Error Status: ${error.response?.status}`);
        console.log(`Error Data:`, JSON.stringify(error.response?.data));
        console.log(`Error Headers:`, JSON.stringify(error.response?.headers));
    }
}

test();