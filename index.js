const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const config = require('./src/config');
const whatsappRoutes = require('./src/routes/whatsapp.routes');
const botRoutes = require('./src/routes/bot.routes');
const axios = require('axios'); // For proxying requests to Laravel

const app = express();
const port = config.port;

// Base Middlewares
app.use(cors());

// Proxy Technical Routes to Laravel (PDFs/Files)
const handleProxy = async (req, res, next) => {
    if (req.method !== 'GET') return next();
    try {
        const targetUrl = `http://localhost:8000${req.originalUrl}`;
        const response = await axios({
            method: 'GET',
            url: targetUrl,
            headers: { 
                ...req.headers,
                'ngrok-skip-browser-warning': 'true', 
                'X-Forwarded-Host': req.headers.host,
                'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || 'https'
            },
            responseType: 'stream',
            validateStatus: false
        });

        // Remove security-sensitive headers 
        const headers = { ...response.headers };
        delete headers['set-cookie'];
        
        // Ensure critical media headers are passed to Meta
        if (response.headers['content-type']) res.set('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
        
        res.set(headers);
        response.data.pipe(res);
    } catch (err) {
        console.error('[PROXY ERROR]:', err.message);
        next();
    }
};

app.use('/api/bot', handleProxy);
app.use('/api/customer', handleProxy);

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
