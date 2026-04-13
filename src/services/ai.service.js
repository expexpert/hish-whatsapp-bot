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
  async parseExpenseText(text, categories = [], phone = null, skipCooldown = false) {
    if (this.openai && phone) {
      const status = await laravelService.checkAiStatus(phone, skipCooldown);
      if (!status.allowed) {
        throw new Error(status.message || "AI quota exceeded.");
      }
      return this.parseWithOpenAI(text, categories, phone, skipCooldown);
    }
    return this.parseWithRegex(text);
  }

  /**
   * ADVANCED: NLP using GPT-4o-mini (highly efficient)
   */
  async parseWithOpenAI(text, categories = [], phone = null, skipCooldown = false) {
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
                      "Try to match with 'Available Categories'. If no match, suggest a simple/logical new category. Do NOT use 'General' if a better inference exists. " +
                      "Classify as 'EXPENSE' (receipt), 'STATEMENT' (bank summary), or 'INVOICE' (sales/income). " + 
                      "Extract the Supplier (for expenses) or Client (for invoices) name into 'entity'. " +
                      "IMPORTANT: If the message starts with a command verb like 'Bill', 'Invoice', or 'Record' (e.g., 'Bill 100 to...'), do NOT take the word 'Bill' or 'Invoice' as the client name. " +
                      "CRITICAL: If you are unsure of the entity name or it is a command, return 'Unknown' for 'entity'. " + 
                      "Output JSON only: { documentType, amount, vat, currency, category, entity, description, monthYear (for statements, MM-YYYY format), payment_method, date (YYYY-MM-DD) }." 
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      // Log usage if phone is provided
      if (phone && response.usage) {
        await laravelService.logAiUsage(phone, model, response.usage.prompt_tokens, response.usage.completion_tokens, skipCooldown);
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
  async transcribeVoice(localFilePath, phone = null, skipCooldown = false) {
    if (this.openai && phone) {
      const status = await laravelService.checkAiStatus(phone, skipCooldown);
      if (!status.allowed) {
        throw new Error(status.message || "AI quota exceeded.");
      }
      return this.transcribeWithWhisper(localFilePath, phone, skipCooldown);
    }
    return this.mockTranscription(localFilePath);
  }

  /**
   * ADVANCED: OpenAI Whisper
   */
  async transcribeWithWhisper(localFilePath, phone = null, skipCooldown = false) {
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
          await laravelService.logAiUsage(phone, "whisper-1", 0, 0, skipCooldown); 
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
                text: `You are an accounting assistant. Today's Date is ${today}. Analyze this document. 
                Classify as:
                - 'EXPENSE': Any receipt, bill, or proof of payment for goods/services.
                - 'INVOICE': A sales invoice or request for payment sent to a customer.
                - 'STATEMENT': ONLY if it is a official Bank Statement, Credit Card Summary, or Transaction List from a financial institution.
                - 'UNKNOWN': If it is not a clear accounting document (e.g., a random photo, person, or generic text).

                If 'STATEMENT', extract 'monthYear' in 'MM-YYYY' format based on the period covered.
                
                Return JSON: { "documentType": "EXPENSE"|"INVOICE"|"STATEMENT"|"UNKNOWN", "amount": 0.00, "currency": "USD", "date": "YYYY-MM-DD", "entity": "Supplier/Client Name", "notes": "Brief description", "monthYear": "MM-YYYY" }`
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

  /**
   * INTENT CLASSIVER: Determines what the user wants to do from natural language
   */
  async classifyIntent(text, phone = null, skipCooldown = false) {
      if (!this.openai || !text) return 'UNKNOWN';
      
      try {
          // 1. Quota Check (Standard for all AI entry points)
          if (phone) {
              const status = await laravelService.checkAiStatus(phone, skipCooldown);
              if (!status.allowed) return 'UNKNOWN'; // Silent fail for intent sensing to prevent blocking flow
          }

          const response = await this.openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                  { 
                      role: "system", 
                      content: "Classify the user's intent into exactly ONE of these tokens: " +
                                "STATUS (wants reports, dashboard, balance, stats), " + 
                                "EXPENSE (OUTFLOW/SPENDING: paid someone, purchase, receipt, cost. e.g. 'Paid Google 500', 'Spent 10', 'Amazon receipt', 'Phone bill'), " +
                                "INVOICE (INFLOW/INCOME: record a sale, bill a client, client paid you. e.g. 'Bill Client ABC 1000', 'Invoice for services', 'Sold product to X'), " +
                                "STATEMENT (wants to upload bank statements), " +
                                "ACCOUNTANT (wants to ask a question to their accountant), " +
                                "MENU (wants to start over, welcome message, cancel current task), " +
                                "UNKNOWN (none of the above). " +
                                "CRITICAL LOGIC: 'Paid [Someone]' is always an EXPENSE. 'Billed [Someone]' or 'Invoice to [Someone]' is always an INVOICE. " +
                                "Context Clue: If the user says 'Bill [Amount]' as a command, it is an INVOICE. If they name a service like 'Electricity Bill', it is an EXPENSE. " +
                                "Output the token only."
                  },
                  { role: "user", content: text }
              ],
              max_tokens: 10
          });

          const intent = response.choices[0].message.content.trim().toUpperCase();
          console.log(`🤖 AI INTENT SENSING: "${text}" -> ${intent}`);

          // Log usage
          if (phone) {
              await laravelService.logAiUsage(phone, "gpt-4o-mini", response.usage.prompt_tokens, response.usage.completion_tokens, skipCooldown);
          }

          const validIntents = ['STATUS', 'EXPENSE', 'INVOICE', 'STATEMENT', 'ACCOUNTANT', 'MENU'];
          return validIntents.includes(intent) ? intent : 'UNKNOWN';
      } catch (error) {
          console.error('AI Intent Classification Error:', error.message);
          return 'UNKNOWN';
      }
  }
  /**
   * STATEMENT MONTH PARSER: Converts natural language to standardized "Month YYYY"
   */
  async parseStatementMonth(text, phone = null, skipCooldown = false) {
    if (!this.openai || !text) return 'Unknown';
    const today = new Date().toISOString().split('T')[0];
    
    try {
        if (phone) {
            const status = await laravelService.checkAiStatus(phone, skipCooldown);
            if (!status.allowed) return 'Unknown';
        }

        const response = await this.openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `You are an accounting assistant. Today is ${today}. ` + 
                             "Extract the financial statement period (Month and Year) from the user's message. " +
                             "Standardize to 'Month YYYY' (e.g., 'March 2026'). " +
                             "If the user says 'Last month', calculate it accurately based on today's date. " +
                             "If the user says 'Next week', 'Tomorrow', or anything that isn't a month, return 'Unknown'. " +
                             "Output exactly the standardized string (e.g. 'April 2026') or 'Unknown' and nothing else." 
                },
                { role: "user", content: text }
            ],
            max_tokens: 20
        });

        const result = response.choices[0].message.content.trim();
        
        // Log usage
        if (phone && response.usage) {
            await laravelService.logAiUsage(phone, "gpt-4o-mini", response.usage.prompt_tokens, response.usage.completion_tokens, skipCooldown);
        }

        return result;
    } catch (error) {
        console.error('Statement Parsing Error:', error.message);
        return 'Unknown';
    }
  }
}

module.exports = new AIService();
