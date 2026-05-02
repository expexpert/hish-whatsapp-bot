require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const botController = require('./src/controllers/bot.controller.js');
const { verifyMetaSignature } = require('./src/middleware/auth.middleware.js');
const config = require('./src/config.js');

const app = express();
const port = process.env.PORT || 3006;

app.use(cors());

// Middleware to capture raw body for signature verification
app.use(bodyParser.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

/**
 * 1. Webhook Verification (GET)
 * Used by Meta to verify the server’s authenticity.
 */
app.get('/api/whatsapp/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
            console.log('🛡️ Webhook Verified Successfully!');
            res.status(200).send(challenge);
        } else {
            console.error('❌ Webhook Verification Failed: Token mismatch.');
            res.sendStatus(403);
        }
    }
});

/**
 * 2. Webhook Event Handling (POST)
 * Receives incoming messages, status updates, and media.
 */
app.post('/api/whatsapp/webhook', verifyMetaSignature, botController.handleIncomingMessage.bind(botController));

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'UP', service: 'Real AI Chatbot', mode: 'Context-Aware' });
});

app.listen(port, () => {
    console.log(`🚀 Real AI Chatbot is running on port ${port}`);
    console.log(`🔗 Webhook GET URL:  ${config.botPublicUrl}/api/whatsapp/webhook`);
    console.log(`🔗 Webhook POST URL: ${config.botPublicUrl}/api/whatsapp/webhook`);
});
