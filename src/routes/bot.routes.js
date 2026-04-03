const express = require('express');
const router = express.Router();
const botController = require('../controllers/bot.controller');

router.post('/send-otp', botController.sendAuthOtp.bind(botController));

module.exports = router;
