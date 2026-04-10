require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3005,
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    skipSignatureAuth: process.env.SKIP_SIGNATURE_AUTH === 'true',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v22.0',
    baseUrl: `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v22.0'}`
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || null
  },
  botPublicUrl: process.env.BOT_PUBLIC_URL || 'https://loura-dismal-electrovalently.ngrok-free.dev',
  botSecret: process.env.WHATSAPP_BOT_SECRET,
  bypassAuth: process.env.BOT_AUTH_BYPASS === 'true',
  skipAiLimits: process.env.SKIP_AI_LIMITS === 'true',
  storageDir: process.env.STORAGE_DIR || '/tmp/whatsapp-bot-storage'
};
