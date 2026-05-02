const laravelService = require('../src/services/laravel.service');

async function testBotSideTaxMapping() {
    console.log("=========================================");
    console.log("   BOT-SIDE MAP VERIFICATION TEST");
    console.log("=========================================");

    // Mock Live API response for taxes (Product Resources)
    const taxResources = {
        tax: [
            { id: 8, name: "VAT 20%", rate: "20" },
            { id: 2, name: "VAT 1%", rate: "1" }
        ]
    };

    // Mock Live API response for Invoices (No nested tax.rate)
    const invoices = [
        {
            status: "ISSUED",
            currency: "USD",
            amount: 1000,
            articles: [
                { total_price_ht: 1000, tva_percentage: 8 } // ID 8 = 20% -> 200 VAT
            ]
        },
        {
            status: "ISSUED",
            currency: "USD",
            amount: 1000,
            articles: [
                { total_price_ht: 1000, tva_percentage: 2 } // ID 2 = 1% -> 10 VAT
            ]
        }
    ];

    // Build Bot-Side Tax Map
    const taxMap = {};
    if (taxResources && taxResources.tax) {
        taxResources.tax.forEach(t => {
            taxMap[t.id] = parseFloat(t.rate || 0);
        });
    }
    
    console.log("Bot-Side Tax Map Built:", taxMap);

    // Apply the exact loop from whatsapp.controller.js
    const revenueStats = invoices.reduce((acc, inv) => {
        const articles = inv.articles || [];
        const invHT = articles.reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0) || parseFloat(inv.amount || 0);
        
        const invVAT = articles.reduce((sum, art) => {
            const ht = parseFloat(art.total_price_ht || 0);
            
            let rate = 0;
            if (art.tax && art.tax.rate !== undefined) {
                rate = parseFloat(art.tax.rate);
            } else if (art.tva_percentage && taxMap[art.tva_percentage] !== undefined) {
                rate = taxMap[art.tva_percentage];
                console.log(`[MAP HIT] Successfully translated ID ${art.tva_percentage} to Rate ${rate}%`);
            } else {
                rate = parseFloat(art.tva_percentage || 0);
            }
            
            return sum + (ht * (rate / 100));
        }, 0);

        acc.revenueHT += invHT;
        acc.vatCollected += invVAT;
        return acc;
    }, { revenueHT: 0, vatCollected: 0 });

    console.log("\nResults:");
    console.log(`Expected HT: 2000.00 | Output: ${revenueStats.revenueHT.toFixed(2)}`);
    console.log(`Expected VAT: 210.00 | Output: ${revenueStats.vatCollected.toFixed(2)}`);
    
    if (revenueStats.vatCollected === 210) console.log("✅ VERIFICATION PASSED!");
    else console.error("❌ VERIFICATION FAILED!");

    console.log("=========================================\n");
}

testBotSideTaxMapping().catch(console.error);
