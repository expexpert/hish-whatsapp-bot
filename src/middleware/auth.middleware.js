const crypto = require('crypto');
const config = require('../config');

/**
 * Verifies the X-Hub-Signature-256 header sent by Meta hooks
 */
const verifyMetaSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = config.whatsapp.appSecret;
  if (!signature || !appSecret) {
    // For demo skip if no app secret set
    if (!appSecret) {
        console.warn('⚠️  WARNING: WHATSAPP_APP_SECRET is not set in .env. Skipping security check for testing.');
        return next();
    }
    console.error('❌ REJECTED: Request is missing the X-Hub-Signature-256 header.');
    return res.status(401).send('Signature missing');
  }

  const [algo, hash] = signature.split('=');
  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  if (hash !== expectedHash) {
    console.error('❌ REJECTED: Signature mismatch detected!');
    console.error(`Received: ${hash}`);
    console.error(`Expected: ${expectedHash}`);
    console.error(`Secret used: ${appSecret.substring(0, 4)}***`);
    return res.status(401).send('Signature mismatch');
  }
  
  console.log('🛡️  Signature Verified Successfully');
  next();
};

const verifyBotSecret = (req, res, next) => {
    const secret = req.headers['x-bot-secret'];
    const expectedSecret = config.whatsapp.appSecret;

    if (!secret || secret !== expectedSecret) {
        console.error('❌ REJECTED: Bot Secret mismatch or missing.');
        return res.status(401).json({ status: 'error', message: 'Unauthorized: Bot Secret mismatch' });
    }

    console.log('🛡️  Bot Secret Verified Successfully');
    next();
};

module.exports = { verifyMetaSignature, verifyBotSecret };
