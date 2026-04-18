const axios = require('axios');

class LaravelService {
  constructor() {
    this.baseUrl = (process.env.LARAVEL_API_URL || 'http://localhost:8000/api') + '/bot';
    this.publicUrl = process.env.LARAVEL_PUBLIC_URL || 'http://localhost:8000';
    this.botSecret = process.env.WHATSAPP_BOT_SECRET ;
  }

  getBotHeaders(phone = null, skipCooldown = false) {
    // Extract host from publicUrl (e.g., https://domain.com -> domain.com)
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

    if (skipCooldown) {
      headers['X-AI-Skip-Cooldown'] = 'true';
    }
    
    // Global AI Limits Bypass (Controlled via Header)
    if (process.env.SKIP_AI_LIMITS === 'true') {
      headers['X-AI-Skip-Limits'] = 'true';
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
  async getAccountStatus(phone, targetMonth = null, targetYear = null, clientId = null, supplierId = null) {
    const rawTargetMonth = targetMonth;
    const rawTargetYear = targetYear;
    
    try {
      const now = new Date();
      const currentYear = rawTargetYear || now.getFullYear();
      const currentMonthIdx = rawTargetMonth ? (parseInt(rawTargetMonth) - 1) : now.getMonth();
      const monthNum = String(currentMonthIdx + 1).padStart(2, '0');
      
      const params = {};
      
      // Only apply date filters if a specific month/year is requested
      if (rawTargetMonth || rawTargetYear) {
          const startStr = `${currentYear}-${monthNum}-01`;
          const lastDay = new Date(currentYear, currentMonthIdx + 1, 0).getDate();
          const endStr = `${currentYear}-${monthNum}-${String(lastDay).padStart(2, '0')}`;
          
          params.date_from = startStr;
          params.date_to = endStr;
      }

      if (clientId) params.client_id = clientId;
      if (supplierId) params.supplier_id = supplierId;

      const response = await axios.get(`${this.baseUrl}/customer/dashboard-data`, {
        params: params,
        timeout: 15000, // 15 seconds safety cutoff
        headers: this.getBotHeaders(phone)
      });

      const data = response.data.data;
      
      // Calculate display period string
      let periodLabel = "All Time";
      if (rawTargetMonth || rawTargetYear) {
          const displayDate = new Date(currentYear, currentMonthIdx, 1);
          periodLabel = displayDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      }

      return {
        month: periodLabel,
        status: data.is_enable_login ? 'Active' : 'Pending',
        totalDocuments: (parseInt(data.total_issued_count) || 0) + (parseInt(data.total_paid_count) || 0) + (parseInt(data.total_expenses_count) || 0),
        invoicesCount: (parseInt(data.total_issued_count) || 0) + (parseInt(data.total_paid_count) || 0),
        expensesCount: parseInt(data.total_expenses_count) || 0,

        // Core Financials (Mapped to Main Branch Logic)
        salesSum: parseFloat(data.total_issued_paid_sum) || 0,
        cash_revenue_sum: parseFloat(data.total_paid_sum) || 0,
        total_unpaid_sum: parseFloat(data.unpaidInvoiceSum) || 0,
        total_quote_sum: parseFloat(data.total_quote_sum) || 0,
        cash_vat_sum: parseFloat(data.total_vat_payable) || 0,
        total_paid_sum: parseFloat(data.total_paid_sum) || 0,
        
        pendingReviewCount: parseInt(data.total_pending_review_count) || 0,
        statementsCount: parseInt(data.bank_statements_count) || 0,
        
        expensesSum: parseFloat(data.total_expenses_sum) || 0,
        total_expenses_sum: parseFloat(data.total_expenses_sum) || 0,
        expenseVat: parseFloat(data.total_expenses_vat) || 0,
        vatPayable: parseFloat(data.total_vat_payable) || 0,
        recentDocuments: [],
        targetMonth: monthNum,
        targetYear: currentYear
      };
    } catch (error) {
      console.error('Laravel Hybrid Status Error:', error.response?.data || error.message);
      return { 
        month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        targetMonth: String(new Date().getMonth() + 1).padStart(2, '0'),
        targetYear: new Date().getFullYear(),
        status: 'Error fetching data',
        documentsReceived: 0,
        salesSum: 0,
        cash_revenue_sum: 0,
        total_unpaid_sum: 0,
        total_quote_sum: 0,
        cash_vat_sum: 0,
        expensesSum: 0,
        total_expenses_sum: 0,
        expenseVat: 0,
        vatPayable: 0,
        recentDocuments: []
      };
    }
  }

  async getInvoices(phone, status = null, month = null, year = null, clientId = null, id = null) {
    try {
      const response = await axios.get(`${this.baseUrl}/customer/customer-invoices`, {
        params: { status, month, year, client_id: clientId, id },
        headers: this.getBotHeaders(phone)
      });
      return response.data.data || [];
    } catch (error) {
      console.error('getInvoices error:', error.message);
      return [];
    }
  }

  async getExpenses(phone, month = null, year = null, supplierId = null, id = null) {
    try {
      const response = await axios.get(`${this.baseUrl}/customer/customer-expenses`, {
        params: { month, year, supplier_id: supplierId, id },
        headers: this.getBotHeaders(phone)
      });
      return response.data.data || [];
    } catch (error) {
      console.error('getExpenses error:', error.message);
      return [];
    }
  }

  async getBankStatements(phone, month = null, year = null) {
    try {
      // Logic for statements: if month/year provided, we could filter by STR_TO_DATE.
      // For now, we'll pass filter if only year provided, or just let backend handle pagination.
      const params = {};
      if (year && month) params.filter = `${month}-${year}`;
      else if (year) params.filter = year;

      const response = await axios.get(`${this.baseUrl}/customer/bank-statements`, {
        params,
        headers: this.getBotHeaders(phone)
      });
      return response.data.data || [];
    } catch (error) {
      console.error('getBankStatements error:', error.message);
      return [];
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
        const ext = filePath.toLowerCase();
        const isSupported = ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png') || ext.endsWith('.pdf');
        
        if (isSupported) {
          form.append('file', fs.createReadStream(filePath));
        } else {
          console.log(`📎 [INFO] Skipping non-image attachment for Laravel API: ${filePath}`);
        }
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
          const invoiceDateStr = data.date || new Date().toISOString().split('T')[0];
          const invoiceDate = new Date(invoiceDateStr);
          const dueDate = new Date(invoiceDate);
          dueDate.setDate(dueDate.getDate() + 30);
          
          form.append('date', invoiceDateStr);
          form.append('due_date', dueDate.toISOString().split('T')[0]);
          form.append('invoice_number', `INV-WA-${Date.now()}`); // Standard API requires unique invoice number
          form.append('status', data.status || 'ISSUED');

          // Add a default article so the invoice shows up in the dashboard sums
          const designation = data.notes || data.description || 'Professional Services';
          form.append('articles[0][designation]', designation);
          form.append('articles[0][quantity]', 1);
          form.append('articles[0][unit_price_ht]', data.amount);
          form.append('articles[0][total_price_ht]', data.amount);
          form.append('articles[0][tva_percentage]', data.vat || 0);

          if (filePath && fs.existsSync(filePath)) {
              const ext = filePath.toLowerCase();
              const isSupported = ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png') || ext.endsWith('.pdf');
              
              if (isSupported) {
                  form.append('document', fs.createReadStream(filePath));
              } else {
                  console.log(`📎 [INFO] Skipping non-image/PDF invoice attachment for Laravel API: ${filePath}`);
              }
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
      const response = await axios.get(`${this.baseUrl}/customer/customer-clients?sort=recent`, {
        timeout: 15000,
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
      const response = await axios.get(`${this.baseUrl}/customer/transaction-resources?sort=recent`, {
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
  async checkAiStatus(phone, skipCooldown = false) {
    try {
      const response = await axios.get(`${this.baseUrl}/customer/ai/status`, {
        headers: this.getBotHeaders(phone, skipCooldown)
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
  async logAiUsage(phone, model, tokensIn, tokensOut, skipCooldown = false) {
    try {
      await axios.post(`${this.baseUrl}/customer/ai/log`, {
        model,
        tokens_in: tokensIn,
        tokens_out: tokensOut
      }, {
        headers: this.getBotHeaders(phone, skipCooldown)
      });
    } catch (error) {
      console.error('Laravel AI Log Error:', error.message);
    }
  }
}

module.exports = new LaravelService();
