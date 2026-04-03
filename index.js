const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const config = require('./src/config');
const whatsappRoutes = require('./src/routes/whatsapp.routes');
const botRoutes = require('./src/routes/bot.routes');

const app = express();
const port = config.port;

// Base Middlewares
app.use(cors());
app.use(bodyParser.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Routes
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/v1/bot', botRoutes);
app.use('/storage', express.static(config.storageDir));

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'UP', message: 'WhatsApp Service is running' });
});

// Start Server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Webhook URL: http://localhost:${port}/api/whatsapp/webhook`);
});
