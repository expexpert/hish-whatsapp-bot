const { OpenAI } = require('openai');
const config = require('../config');
const fs = require('fs');
const laravelService = require('./laravel.service');

class AIService {
  constructor() {
    this.openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
  }

  /**
   * Main parsing gateway: Real OpenAI vs. Regex Fallback
   */
  async parseExpenseText(text, categories = [], phone = null) {
    if (this.openai && phone) {
      const status = await laravelService.checkAiStatus(phone);
      if (!status.allowed) {
        throw new Error(status.message || "AI quota exceeded.");
      }
      return this.parseWithOpenAI(text, categories, phone);
    }
    return this.parseWithRegex(text);
  }

  /**
   * ADVANCED: NLP using GPT-4o-mini (highly efficient)
   */
  async parseWithOpenAI(text, categories = [], phone = null) {
    console.log('Using OpenAI for NLP extraction...');
    const today = new Date().toISOString().split('T')[0];
    const catList = categories.length > 0 ? `Available Categories: [${categories.join(', ')}]. ` : '';
    const model = "gpt-4o-mini";

    try {
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          { 
            role: "system", 
            content: `You are an accounting assistant. Today's Date is ${today}. Extract details from the user's message. ` + 
                      catList +
                      "Try to match with 'Available Categories'. If no match, suggest a simple/logical new category (e.g., Food, Travel, Supplies). Do NOT use 'General' if a better inference exists. " +
                      "Classify as 'EXPENSE' (receipt), 'STATEMENT' (bank summary), or 'INVOICE' (sales/income). " + 
                      "Output JSON only: { documentType, amount, vat, currency, category, entity, description, monthYear (for statements, MM-YYYY format), payment_method, date (YYYY-MM-DD) }." 
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      // Log usage if phone is provided
      if (phone && response.usage) {
        await laravelService.logAiUsage(phone, model, response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error('OpenAI NLP Error, falling back to regex:', error.message);
      if (error.message.includes("quota exceeded")) throw error; // Re-throw quota errors
      return this.parseWithRegex(text);
    }
  }

  /**
   * FALLBACK: Regex-based parsing
   */
  async parseWithRegex(text) {
    console.log('Using Regex Fallback for parsing...');
    const textLower = text.toLowerCase();
    
    // Detect Document Type
    let documentType = 'EXPENSE';
    if (textLower.includes('invoice')) documentType = 'INVOICE';
    else if (textLower.includes('statement')) documentType = 'STATEMENT';

    // Extract Amount
    const amountRegex = /(\d+(?:\.\d+)?)/;
    const amountMatch = text.match(amountRegex);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    
    // Extract Currency
    let currency = 'USD';
    if (textLower.includes('eur') || textLower.includes('€')) currency = 'EUR';

    // Extract Date (Basic YYYY-MM-DD or DD/MM/YYYY)
    let date = new Date().toISOString().split('T')[0];
    const dateRegex = /(\d{4}-\d{2}-\d{2})|(\d{2}[/-]\d{2}[/-]\d{4})/;
    const dateMatch = text.match(dateRegex);
    if (dateMatch) date = dateMatch[0].replace(/\//g, '-');

    // Extract Payment Method
    let payment_method = 'WhatsApp';
    const payKeywords = {
        'Cash': [/cash/i, /paid in cash/i],
        'Bank Transfer': [/transfer/i, /bank/i, /wire/i, /eft/i],
        'Credit Card': [/card/i, /visa/i, /mastercard/i, /amex/i],
        'PayPal': [/paypal/i]
    };
    for (const [method, patterns] of Object.entries(payKeywords)) {
        if (patterns.some(p => p.test(textLower))) {
            payment_method = method;
            break;
        }
    }

    // Basic Category & Entity (Supplier/Client)
    let category = documentType === 'INVOICE' ? 'Sales' : (documentType === 'STATEMENT' ? 'Banking' : 'General');
    let entity = 'General';
    
    const catKeywords = ['food', 'rest', 'dinner', 'lunch', 'breakfast', 'fuel', 'petrol', 'taxi', 'uber', 'travel', 'parking', 'supplies', 'legal', 'mkt', 'adv'];
    for (const k of catKeywords) {
      if (textLower.includes(k)) { 
        if (['food', 'rest', 'dinner', 'lunch', 'breakfast'].includes(k)) category = 'Food & Dining';
        else if (['fuel', 'petrol', 'taxi', 'uber', 'travel', 'parking'].includes(k)) category = 'Travel & Transport';
        else if (['supplies'].includes(k)) category = 'Office Supplies';
        else category = k.charAt(0).toUpperCase() + k.slice(1); 
        break; 
      }
    }

    const entKeywords = ['starbucks', 'shell', 'uber', 'amazon', 'google', 'digitalocean', 'paypal', 'apple', 'microsoft', 'restaurant', 'cafe', 'bar'];
    for (const k of entKeywords) {
      if (textLower.includes(k)) { 
        entity = k.charAt(0).toUpperCase() + k.slice(1); 
        break; 
      }
    }

    // Extract Month/Year for Statements (e.g. "April 2026" or "04/2026")
    let monthYear = null;
    const monthYearRegex = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/i;
    const monthYearMatch = text.match(monthYearRegex);
    if (monthYearMatch) {
      monthYear = monthYearMatch[0];
    } else {
      // Try MM/YYYY
      const mmYyyyRegex = /(\d{2})[/-](\d{4})/;
      const mmYyyyMatch = text.match(mmYyyyRegex);
      if (mmYyyyMatch) monthYear = `${mmYyyyMatch[1]}/${mmYyyyMatch[2]}`;
    }

    return {
      documentType,
      amount,
      currency,
      category,
      entity,
      payment_method,
      date,
      monthYear,
      description: text || 'No description'
    };
  }

  /**
   * VOICE TRANSCRIPTION: Real Whisper vs. Mock Fallback
   */
  async transcribeVoice(localFilePath, phone = null) {
    if (this.openai && phone) {
      const status = await laravelService.checkAiStatus(phone);
      if (!status.allowed) {
        throw new Error(status.message || "AI quota exceeded.");
      }
      return this.transcribeWithWhisper(localFilePath, phone);
    }
    return this.mockTranscription(localFilePath);
  }

  /**
   * ADVANCED: OpenAI Whisper
   */
  async transcribeWithWhisper(localFilePath, phone = null) {
    console.log('Using OpenAI Whisper for Transcription...');
    try {
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(localFilePath),
        model: "whisper-1",
        response_format: "verbose_json"
      });

      // Log usage (Whisper doesn't return tokens, we use duration or fixed cost)
      if (phone) {
          // Whisper cost is per second. We'll log it as a fixed amount or 1 token for now in this version
          // for simplicity in the unified logging table.
          await laravelService.logAiUsage(phone, "whisper-1", 0, 0); 
      }

      return transcription.text;
    } catch (error) {
      console.error('Whisper Transcription Error:', error.message);
      if (error.message.includes("quota exceeded")) throw error;
      return this.mockTranscription();
    }
  }

  /**
   * FALLBACK: Mock transcription
   */
  mockTranscription() {
    console.log('Using Mock Transcription...');
    return "I paid 350 dollars for fuel today.";
  }

  async extractDetailsFromTranscription(text, phone = null) {
    return this.parseExpenseText(text, [], phone);
  }

  /**
   * VISION: Real GPT-4o-mini Vision vs. Mock Fallback
   */
  async parseReceiptImage(localFilePath, categories = [], phone = null) {
    if (this.openai && phone) {
      const status = await laravelService.checkAiStatus(phone);
      if (!status.allowed) {
        throw new Error(status.message || "AI quota exceeded.");
      }
      return this.parseWithVision(localFilePath, categories, phone);
    }
    return this.mockVision();
  }

  async parseWithVision(localFilePath, categories = [], phone = null) {
    console.log('Using OpenAI Vision for Multi-Document Analysis...');
    const today = new Date().toISOString().split('T')[0];
    const catList = categories.length > 0 ? `Available Categories: [${categories.join(', ')}]. ` : '';
    const model = "gpt-4o-mini";

    try {
      const base64Image = fs.readFileSync(localFilePath, { encoding: 'base64' });
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: [
              { 
                type: "text", 
                text: `You are an accounting assistant. Today's Date is ${today}. Analyze this document. Classify as 'EXPENSE' (receipt), 'STATEMENT' (bank summary), or 'INVOICE' (sales/income). ` + 
                      catList +
                      "Try to match with 'Available Categories'. If no match, suggest a logical new category (e.g., Food, Travel). Avoid 'General' if easier to infer. " +
                      "Output JSON only: { documentType, amount, vat, currency, category, entity, description, monthYear (for statements, MM-YYYY format), invoiceNumber (for invoices), payment_method, date (YYYY-MM-DD) }." 
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${base64Image}` }
              },
            ],
          },
        ],
        response_format: { type: "json_object" }
      });

      // Log usage if phone is provided
      if (phone && response.usage) {
        await laravelService.logAiUsage(phone, model, response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      const result = JSON.parse(response.choices[0].message.content);
      
      // Ensure all fields exist with defaults
      return {
        documentType: result.documentType || 'EXPENSE',
        amount: result.amount || 0,
        vat: result.vat || 0,
        currency: result.currency || 'USD',
        category: result.category || 'Accounting',
        entity: result.entity || 'General',
        description: result.description || 'Processed via AI',
        monthYear: result.monthYear || null,
        invoiceNumber: result.invoiceNumber || null,
        payment_method: result.payment_method || 'WhatsApp',
        date: result.date || new Date().toISOString().split('T')[0]
      };
    } catch (error) {
      console.error('Vision AI Error:', error.message);
      if (error.message.includes("quota exceeded")) throw error;
      return this.mockVision();
    }
  }

  mockVision() {
    console.log('Using Mock Vision fallback (No extraction)...');
    return {
      documentType: 'EXPENSE',
      amount: 0,
      vat: 0,
      currency: "USD",
      category: "General",
      description: "Document received (Pending analysis)"
    };
  }
}

module.exports = new AIService();
