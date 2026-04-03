const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsapp.controller');
const { verifyMetaSignature, verifyBotSecret } = require('../middleware/auth.middleware');

/**
 * ROUTES FOR WHATSAPP INTEGRATION
 */

// Webhook Verification (GET) - Required by Meta
router.get('/webhook', whatsappController.verifyWebhook);

// Webhook Events (POST) - From Meta to Us
// We add verifying the signature as middleware for security

router.post('/webhook', verifyMetaSignature, whatsappController.handleWebhookEvent.bind(whatsappController));

// API Endpoint to send a template (Internal Use)
router.post('/send-template', whatsappController.sendTemplate.bind(whatsappController));

// API Endpoint to send a text message (Internal Use for OTP/Notifications)
router.post('/send-message', verifyBotSecret, whatsappController.handleOutgoingMessage.bind(whatsappController));

// Simple test POST /test
router.post('/test', whatsappController.sendHelloWorld.bind(whatsappController));

module.exports = router;
