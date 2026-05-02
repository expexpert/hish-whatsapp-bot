require('dotenv').config();
const laravelService = require('../src/services/laravel.service');

async function testTaxes() {
    console.log("Fetching taxes from Live API...");
    // We need the phone number from the transcript or database.
    // I'll try fetching with a known phone number or the test one.
    // Let's look at whatsapp.controller.js line 2200 to see how it assigns IDs. Wait, no.
    // Let me just look at the getTaxes method.
    const phone = "212624233777"; // Need a valid phone number. I will check the invoices from earlier to find what phone number the user has.
    // I can get the user's phone from the DB if I query the customer table.
}

testTaxes().catch(console.error);
