const axios = require('axios');
const logger = require('../utils/logger');
require('dotenv').config();

class LaravelService {
    constructor() {
        const backend = process.env.ACTIVE_PHP_BACKEND || 'local';
        
        if (backend === 'live' || backend.startsWith('http')) {
            // Support both direct URL or 'live' toggle
            this.baseUrl = backend.startsWith('http') ? backend : (process.env.LARAVEL_LIVE_API_URL || 'https://simply-compta.com/api');
            this.publicUrl = process.env.LARAVEL_LIVE_PUBLIC_URL || 'https://simply-compta.com';
        } else {
            this.baseUrl = process.env.LARAVEL_LOCAL_API_URL || 'http://localhost:8000/api';
            this.publicUrl = process.env.LARAVEL_LOCAL_PUBLIC_URL || 'http://localhost:8000';
        }

        // Add /bot suffix if not present (as per root bot expectation)
        if (!this.baseUrl.endsWith('/bot')) {
            this.baseUrl += '/bot';
        }

        this.botSecret = process.env.WHATSAPP_BOT_SECRET;
        this.backendMode = backend;
        console.log(`📡 [LARAVEL] Service Initialized. Mode: ${backend} (${this.baseUrl})`);
    }

    getBotHeaders(phone = null, skipCooldown = false) {
        const publicHost = this.publicUrl ? this.publicUrl.replace(/^https?:\/\//, '').split('/')[0] : null;
        const isHttps = this.publicUrl && this.publicUrl.startsWith('https');

        const headers = {
            'X-Bot-Secret': this.botSecret,
            'X-Customer-Phone': phone,
            'Accept': 'application/json'
        };

        if (publicHost) {
            headers['X-Forwarded-Host'] = publicHost;
            headers['X-Forwarded-Proto'] = isHttps ? 'https' : 'http';
        }

        if (skipCooldown) headers['X-AI-Skip-Cooldown'] = 'true';
        if (process.env.SKIP_AI_LIMITS === 'true') headers['X-AI-Skip-Limits'] = 'true';

        return headers;
    }

    async getKnowledgeSnapshot(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/customer/knowledge`, {
                headers: this.getBotHeaders(phone)
            });
            return response.data.data;
        } catch (error) {
            console.error("❌ [LARAVEL] Knowledge Fetch Failed:", error.response?.data || error.message);
            throw error;
        }
    }

    async checkAuth(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/customer/profile`, {
                headers: this.getBotHeaders(phone)
            });
            return response.data.data;
        } catch (error) {
            return null;
        }
    }

    async updateLanguage(phone, lang) {
        try {
            await axios.put(`${this.baseUrl}/customer/profile`, { bot_lang: lang }, {
                headers: this.getBotHeaders(phone)
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    async getAccountStatus(phone, targetMonth = null, targetYear = null, entityId = null, lang = 'fr') {
        try {
            const now = new Date();
            const currentYear = targetYear || now.getFullYear();
            const params = {};
            
            if (targetMonth) {
                const currentMonthIdx = parseInt(targetMonth) - 1;
                const monthNum = String(currentMonthIdx + 1).padStart(2, '0');
                params.date_from = `${currentYear}-${monthNum}-01`;
                params.date_to = `${currentYear}-${monthNum}-${new Date(currentYear, currentMonthIdx + 1, 0).getDate()}`;
            }

            if (entityId) params.client_id = entityId;

            const response = await axios.get(`${this.baseUrl}/customer/dashboard-data`, {
                params: params,
                headers: this.getBotHeaders(phone)
            });

            return response.data;
        } catch (error) {
            console.error('getAccountStatus error:', error.message);
            return null;
        }
    }

    async createExpense(data, filePath = null, phone = null) {
        try {
            const FormData = require('form-data');
            const fs = require('fs');
            const form = new FormData();
            
            // 1. Resolve Category ID (Mandatory for Backend)
            let categoryId = data.category_id;
            if (!categoryId) {
                const categories = await this.getCategories(phone);
                const categoryName = data.category || 'General';
                const match = categories.find(c => 
                    c.name.toLowerCase() === categoryName.toLowerCase() || 
                    categoryName.toLowerCase().includes(c.name.toLowerCase())
                );
                categoryId = match ? match.id : (categories[0]?.id || 1); // Fallback to first or ID 1
            }

            form.append('ttc', data.amount || data.ttc);
            form.append('tva', data.vat || data.tva || 0);
            form.append('notes', data.notes || data.description || data.reason || '');
            form.append('category_id', categoryId);
            form.append('category_name', data.category || 'General');
            form.append('supplier_name', data.entity || data.supplier_name || 'General');
            form.append('payment_method', data.payment_method || 'WhatsApp');
            form.append('date', data.date || new Date().toISOString().split('T')[0]);

            if (filePath && fs.existsSync(filePath)) {
                form.append('file', fs.createReadStream(filePath));
            }

            const response = await axios.post(`${this.baseUrl}/customer/customer-expense`, form, {
                headers: { ...this.getBotHeaders(phone), ...form.getHeaders() }
            });
            return response.data;
        } catch (error) {
            console.error("❌ [LARAVEL] Expense Creation Failed:", error.response?.data || error.message);
            return { success: false, error: error.message };
        }
    }

    async createInvoice(data, filePath, phone) {
        try {
            const FormData = require('form-data');
            const fs = require('fs');
            const form = new FormData();
            
            if (data.client_id) form.append('client_id', data.client_id);
            if (data.client_name) form.append('client_name', data.client_name);
            
            form.append('amount', data.amount);
            form.append('notes', data.notes || data.reason || data.description || '');
            form.append('payment_method', data.payment_method || 'WhatsApp');
            form.append('date', data.date || new Date().toISOString().split('T')[0]);
            form.append('status', data.status || 'ISSUED');

            // Default article logic
            form.append('articles[0][designation]', data.reason || data.description || 'Professional Services');
            form.append('articles[0][quantity]', 1);
            form.append('articles[0][unit_price_ht]', data.amount);
            form.append('articles[0][total_price_ht]', data.amount);
            form.append('articles[0][tva_percentage]', data.tva_percentage || 0);

            if (filePath && fs.existsSync(filePath)) {
                form.append('document', fs.createReadStream(filePath));
            }

            const response = await axios.post(`${this.baseUrl}/customer/customer-invoice`, form, {
                headers: { ...this.getBotHeaders(phone), ...form.getHeaders() }
            });
            return response.data;
        } catch (error) {
            console.error("❌ [LARAVEL] Invoice Creation Failed:", error.response?.data || error.message);
            return { success: false, error: error.message };
        }
    }

    async uploadStatement(filePath, phone, monthYear) {
        try {
            const FormData = require('form-data');
            const fs = require('fs');
            const form = new FormData();
            form.append('month_year', monthYear);
            if (fs.existsSync(filePath)) form.append('statement', fs.createReadStream(filePath));

            const response = await axios.post(`${this.baseUrl}/customer/bank-statement`, form, {
                headers: { ...this.getBotHeaders(phone), ...form.getHeaders() }
            });
            return response.data;
        } catch (error) {
            console.error("❌ [LARAVEL] Statement Upload Failed:", error.response?.data || error.message);
            throw error;
        }
    }

    async getCategories(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/customer/transaction-resources`, {
                headers: this.getBotHeaders(phone)
            });
            return response.data.data.categories || [];
        } catch (error) { return []; }
    }

    async getClients(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/customer/customer-clients?sort=recent`, {
                headers: this.getBotHeaders(phone)
            });
            return response.data.data || [];
        } catch (error) { return []; }
    }

    async getSuppliers(phone) {
        try {
            const response = await axios.get(`${this.baseUrl}/customer/transaction-resources?sort=recent`, {
                headers: this.getBotHeaders(phone)
            });
            return response.data.data.suppliers || [];
        } catch (error) { return []; }
    }
}

module.exports = new LaravelService();
