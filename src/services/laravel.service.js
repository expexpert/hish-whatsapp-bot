const axios = require('axios');

class LaravelService {
  constructor() {
    this.baseUrl = (process.env.LARAVEL_API_URL || 'http://localhost:8000/api') + '/bot/customer';
    this.publicUrl = process.env.LARAVEL_PUBLIC_URL || 'http://localhost:8000';
    this.botSecret = process.env.WHATSAPP_BOT_SECRET ;
  }

  getBotHeaders(phone = null) {
    const headers = {
      'X-Bot-Secret': this.botSecret,
      'Accept': 'application/json',
    };
    if (phone) {
      headers['X-Customer-Phone'] = phone;
    }
    return headers;
  }

  /**
   * Check if a user is active/linked in the dashboard
   */
  async checkAuth(phone) {
    try {
      const response = await axios.get(`${this.baseUrl}/customer/profile`, {
        headers: this.getBotHeaders(phone)
      });
      console.log(`📡 [DEBUG] Profile response for ${phone}: Status ${response.status}`);
      // If the middleware didn't find the user, data will be null
      return response.data.data !== null;
    } catch (error) {
      console.error(`❌ [DEBUG] Laravel Auth Check FAIL for ${phone}:`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Get dynamic dashboard stats for a specific phone number
   */
  async getAccountStatus(phone) {
    console.log(`📊 Fetching Dashboard Data for ${phone} (Hybrid Mode)...`);
    
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

      const response = await axios.get(`${this.baseUrl}/customer/dashboard-data`, {
        headers: this.getBotHeaders(phone),
        params: {
          date_from: startOfMonth,
          date_to: endOfMonth
        }
      });
      const data = response.data.data;
      
      // Standard API might have different keys than the old Bot controller
      return {
        month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        status: data.is_enable_login ? 'Active' : 'Pending',
        totalDocuments: (data.total_issued_count || 0) + (data.total_expenses_count || 0) + (data.bank_statements_count || 0),
        invoicesCount: data.total_issued_count || 0,
        expensesCount: data.total_expenses_count || 0,
        pendingReviewCount: data.total_pending_review_count || 0,
        statementsCount: data.bank_statements_count || 0,
        monthStatus: data.month_status || 'MISSING_DOCUMENTS',
        salesSum: data.total_issued_sum || 0,
        expensesSum: data.total_expenses_sum || 0,
        vatPayable: data.total_vat_payable || 0,
        recentDocuments: [] // Standard dashboard doesn't return recent docs in same payload
      };
    } catch (error) {
      console.error('Laravel Hybrid Status Error:', error.response?.data || error.message);
      return { 
        month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        status: 'Error fetching data',
        documentsReceived: 0,
        expensesSum: 0,
        vatPayable: 0,
        recentDocuments: []
      };
    }
  }

  /**
   * Create an expense via standard Customer API
   */
  async createExpense(data, filePath = null, phone = null) {
    console.log(`📝 Syncing Expense for ${phone} (Hybrid Mode)...`);
    try {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      
      // Map Bot fields to standard API fields (and include names for Trait mapping)
      form.append('ttc', data.amount);
      form.append('tva', data.vat || 0);
      form.append('notes', data.description || '');
      form.append('category_name', data.category || 'General');
      form.append('supplier_name', data.entity || 'General');
      form.append('payment_method', data.payment_method || 'WhatsApp');
      form.append('date', data.date || new Date().toISOString().split('T')[0]);

      if (filePath && fs.existsSync(filePath)) {
        form.append('file', fs.createReadStream(filePath));
      }

      const response = await axios.post(`${this.baseUrl}/customer/customer-expense`, form, {
        headers: {
          ...this.getBotHeaders(phone),
          ...form.getHeaders()
        }
      });
      return response.data;
    } catch (error) {
      console.error('Laravel Hybrid Create Expense Error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Upload bank statement via standard Customer API
   */
  async uploadStatement(filePath, phone, monthYear) {
      console.log(`📄 Uploading Bank Statement for ${phone} (${monthYear})...`);
      try {
          const FormData = require('form-data');
          const fs = require('fs');
          const form = new FormData();
          
          form.append('month_year', monthYear);
          if (fs.existsSync(filePath)) {
              form.append('statement', fs.createReadStream(filePath));
          }

          const response = await axios.post(`${this.baseUrl}/customer/bank-statement`, form, {
              headers: {
                  ...this.getBotHeaders(phone),
                  ...form.getHeaders()
              }
          });
          return response.data;
      } catch (error) {
          console.error('Laravel Hybrid Statement Error:', error.response?.data || error.message);
          throw error;
      }
  }

  /**
   * Create a Customer Invoice via standard Customer API
   */
  async createInvoice(data, filePath, phone) {
      console.log(`🧾 Syncing Customer Invoice for ${phone} (Hybrid Mode)...`);
      try {
          const FormData = require('form-data');
          const fs = require('fs');
          const form = new FormData();
          
          if (data.client_id && data.client_id !== 'skip_client') {
              form.append('client_id', data.client_id);
          }
          if (data.client_name) {
              form.append('client_name', data.client_name);
          }
          
          form.append('amount', data.amount);
          form.append('notes', data.notes || data.description || '');
          form.append('payment_method', data.payment_method || 'WhatsApp');
          form.append('date', data.date || new Date().toISOString().split('T')[0]);
          form.append('invoice_number', `INV-WA-${Date.now()}`); // Standard API requires unique invoice number
          form.append('status', 'ISSUED');

          // Add a default article so the invoice shows up in the dashboard sums
          const designation = data.notes || data.description || 'Professional Services';
          form.append('articles[0][designation]', designation);
          form.append('articles[0][quantity]', 1);
          form.append('articles[0][unit_price_ht]', data.amount);
          form.append('articles[0][total_price_ht]', data.amount);
          form.append('articles[0][tva_percentage]', data.vat || 0);

          if (filePath && fs.existsSync(filePath)) {
              form.append('document', fs.createReadStream(filePath));
          }

          const response = await axios.post(`${this.baseUrl}/customer/customer-invoice`, form, {
              headers: {
                  ...this.getBotHeaders(phone),
                  ...form.getHeaders()
              }
          });
          return response.data;
      } catch (error) {
          console.error('Laravel Hybrid Create Invoice Error:', error.response?.data || error.message);
          throw error;
      }
  }

  /**
   * Get Customer Clients for Interactive List
   */
  async getClients(phone) {
      console.log(`👥 Fetching Clients for ${phone}...`);
      try {
      const response = await axios.get(`${this.baseUrl}/customer/customer-clients`, {
        headers: this.getBotHeaders(phone)
      });
      return response.data.data || [];
    } catch (error) {
          console.error('Laravel Hybrid Get Clients Error:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Get Category List for AI Context
   */
  async getCategories(phone = null) {
      console.log(`📂 Fetching Categories for AI Context...`);
      try {
      const response = await axios.get(`${this.baseUrl}/customer/transaction-resources`, {
        headers: this.getBotHeaders(phone)
      });
      return response.data.data.categories || [];
    } catch (error) {
          console.error('Laravel Hybrid Get Categories Error:', error.response?.data || error.message);
          return [];
      }
  }

  /**
   * Get Supplier List for Interactive Selection
   */
  async getSuppliers(phone) {
      console.log(`🚚 Fetching Suppliers for ${phone}...`);
      try {
      const response = await axios.get(`${this.baseUrl}/customer/transaction-resources`, {
        headers: this.getBotHeaders(phone)
      });
      return response.data.data.suppliers || [];
    } catch (error) {
          console.error('Laravel Hybrid Get Suppliers Error:', error.response?.data || error.message);
          return [];
      }
  }

  /**
   * Check if a user is allowed to use AI (Quota Check)
   */
  async checkAiStatus(phone) {
    try {
      const response = await axios.get(`${this.baseUrl}/customer/ai/status`, {
        headers: this.getBotHeaders(phone)
      });
      return response.data; // { allowed: boolean, reason?: string, message?: string }
    } catch (error) {
      console.error('Laravel AI Status Error:', error.message);
      return { allowed: true }; // Fallback to allow if API is down
    }
  }

  /**
   * Log AI token usage after successful call
   */
  async logAiUsage(phone, model, tokensIn, tokensOut) {
    try {
      await axios.post(`${this.baseUrl}/customer/ai/log`, {
        model,
        tokens_in: tokensIn,
        tokens_out: tokensOut
      }, {
        headers: this.getBotHeaders(phone)
      });
    } catch (error) {
      console.error('Laravel AI Log Error:', error.message);
    }
  }
}

module.exports = new LaravelService();
