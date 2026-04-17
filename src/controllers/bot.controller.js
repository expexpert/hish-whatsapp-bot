const config = require('../config');
const whatsappService = require('../services/whatsapp.service');

class BotController {
  /**
   * Send Authentication OTP via WhatsApp Template
   * Expected: POST /api/v1/bot/send-otp
   * Body: { phone, otp }
   */
  async sendAuthOtp(req, res) {
    try {
      const { phone, otp } = req.body;
      const secret = req.header('X-Bot-Secret');

      if (!secret || secret !== config.botSecret) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized access' });
      }

      if (!phone || !otp) {
        return res.status(400).json({ status: 'error', message: 'Phone and OTP are required' });
      }

      console.log(`🔐 Triggering Auth OTP for ${phone}: ${otp}`);

      // We use the 'auth_otp' template. 
      // Meta Auth templates usually have one parameter in the body: the code.
      const components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: otp }
          ]
        },
        // Most Auth templates also support a 'Copy Code' button
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            { type: 'text', text: otp }
          ]
        }
      ];

      // Note: Template name 'auth_otp' is a placeholder. 
      // User must ensure this exists in Meta Business Suite.
      await whatsappService.sendTemplate(phone, 'auth_otp', 'en_US', components);

      return res.json({ status: 'success', message: 'OTP sent successfully' });
    } catch (error) {
      console.error('Bot Controller Error:', error.message);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }
}

module.exports = new BotController();
