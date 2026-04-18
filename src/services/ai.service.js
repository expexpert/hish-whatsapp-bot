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
    const now = new Date();
    // Generate a relative date reference for the last 7 days to eliminate AI math errors
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dayName = d.toLocaleString('en-US', { weekday: 'long' });
      const dayDate = d.toISOString().split('T')[0];
      days.push(`${dayName}: ${dayDate}`);
    }
    const relativeDaysRef = days.join(', ');
    
    const today = now.toISOString().split('T')[0] + ' (' + now.toLocaleString('en-US', { weekday: 'long' }) + ')';
    const dateContext = `Today's Date: ${today}. Recent Date Reference (Day: YYYY-MM-DD): [${relativeDaysRef}].`;
    const catList = categories.length > 0 ? `Available Categories: [${categories.join(', ')}]. ` : '';
    const model = "gpt-4o-mini";

    try {
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          { 
            role: "system", 
            content: `You are an accounting assistant. ${dateContext} Extract details from the user's message. ` + 
                      catList +
                      "PRIORITY 1: Match exactly or semantically with 'Available Categories' (e.g., if 'Food' is available, map 'Coffee'/'Cafe' to it). " +
                      "PRIORITY 2: If no match in your list, use COMMON MAPPINGS: 'Coffee', 'Lunch' -> 'Meals & Entertainment'. 'Taxi', 'Uber', 'Fuel' -> 'Travel & Transport'. 'Paper', 'Ink' -> 'Office Supplies'. " +
                      "PRIORITY 3: If no match found anywhere else, suggest a simple/logical new category. " +
                      "Do NOT create a NEW category if an existing one in 'Available Categories' is a reasonable match. Do NOT use 'General' or 'Other' if a better inference exists. " +
                      "Classify as 'EXPENSE' (receipt), 'STATEMENT' (bank summary), or 'INVOICE' (sales/income). " + 
                      "Extract the status of the document into 'status'. For invoices: ['Paid', 'Unpaid', 'Draft']. For expenses: ['Paid', 'Pending']. If the user does NOT explicitly mention the status (like 'paid' or 'draft'), you MUST return null for 'status'. Do NOT guess. " +
                      "Extract the Supplier (for expenses) or Client (for invoices) name into 'entity'. Confidently extract the location or business name after prepositions like 'at', 'to', or 'from' (e.g., 'at the museum' -> 'Museum', 'paid to Amazon' -> 'Amazon'). " +
                      "CRITICAL: Only return 'Unknown' if there is absolutely no mention of a place or person. If a location is mentioned, use it. " +
                      "IMPORTANT: If the message starts with a command verb like 'Bill', 'Invoice', or 'Record' (e.g., 'Bill 100 to...'), do NOT take the word 'Bill' or 'Invoice' as the client name. " +
                      "PAYMENT METHODS: Strictly identify and map to one of: ['Cash', 'Bank Transfer', 'Credit/Debit Card', 'Cheque', 'Mobile Payment', 'Online Payment', 'Direct Debit', 'Deferred Payment', 'Instant Bank Transfer', 'PayPal', 'Other']. " +
                      "IMPORTANT: If the payment method is NOT mentioned in the text or visible on the receipt, return `null` for 'payment_method'. Do NOT guess 'Other' or 'WhatsApp'. " +
                      "IMPORTANT: For the 'date' field, only return a date if clearly mentioned or identifiable. If not found, return `null`. " +
                      "IMPORTANT: Extract the currency accurately (e.g., 'MAD', 'EUR', 'USD'). If not mentioned, default to 'MAD'. " +
                      "Output JSON only: { documentType, status, amount, vat, currency, category, entity, description, monthYear (for statements, MM-YYYY format), payment_method, date (YYYY-MM-DD) }." 
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
    let currency = 'MAD';
    if (textLower.includes('eur') || textLower.includes('€')) currency = 'EUR';
    else if (textLower.includes('usd') || textLower.includes('$')) currency = 'USD';
    else if (textLower.includes('mad') || textLower.includes('dirham')) currency = 'MAD';

    // Extract Date
    let date = null;
    const dateRegex = /(\d{4}-\d{2}-\d{2})|(\d{2}[/-]\d{2}[/-]\d{4})/;
    const dateMatch = text.match(dateRegex);
    if (dateMatch) date = dateMatch[0].replace(/\//g, '-');

    // Extract Payment Method
    let payment_method = null;
    const payKeywords = {
        'Cash': [/cash/i, /paid in cash/i, /espèce/i],
        'Bank Transfer': [/transfer/i, /bank/i, /wire/i, /virement/i, /eft/i],
        'Credit/Debit Card': [/card/i, /visa/i, /mastercard/i, /amex/i, /carte/i, /cb/i],
        'Cheque': [/cheque/i, /chèque/i],
        'Mobile Payment': [/mobile/i, /phone/i, /m-pesa/i, /orange money/i, /momo/i],
        'Online Payment': [/online/i, /web/i, /internet/i, /stripe/i],
        'Direct Debit': [/direct debit/i, /prélèvement/i, /auto-pay/i],
        'Deferred Payment': [/deferred/i, /later/i, /post-paid/i],
        'Instant Bank Transfer': [/instant/i, /faster payment/i],
        'PayPal': [/paypal/i],
        'Other': [/other/i, /autre/i]
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
    
    const catKeywords = ['food', 'rest', 'dinner', 'lunch', 'breakfast', 'coffee', 'cafe', 'fuel', 'petrol', 'taxi', 'uber', 'travel', 'parking', 'supplies', 'legal', 'mkt', 'adv'];
    for (const k of catKeywords) {
      if (textLower.includes(k)) { 
        if (['food', 'rest', 'dinner', 'lunch', 'breakfast', 'coffee', 'cafe'].includes(k)) category = 'Food & Dining';
        else if (['fuel', 'petrol', 'taxi', 'uber', 'travel', 'parking'].includes(k)) category = 'Travel & Transport';
        else if (['supplies'].includes(k)) category = 'Office Supplies';
        else category = k.charAt(0).toUpperCase() + k.slice(1); 
        break; 
      }
    }

    const entKeywords = ['starbucks', 'shell', 'uber', 'amazon', 'google', 'digitalocean', 'paypal', 'apple', 'microsoft', 'restaurant', 'cafe', 'bar', 'museum', 'zomato', 'swiggy', 'ubereats', 'deliveroo', 'glovo'];
    for (const k of entKeywords) {
      if (textLower.includes(k)) { 
        entity = k.charAt(0).toUpperCase() + k.slice(1); 
        break; 
      }
    }

    // Extraction patterns (e.g., "at the museum", "to Amazon")
    const entMatch = text.match(/(?:at|to|from)\s+(?:the\s+)?([a-z0-9\s]+?)(?:\s+for|\s+on|\s+paid|$)/i);
    if (entMatch && entity === 'General') {
      entity = entMatch[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
                text: `You are an accounting assistant specialized in Moroccan bookkeeping. Today's Date is ${today}. Analyze this document. 
                Classify as:
                - 'EXPENSE': Any receipt, bill, or proof of payment for goods/services.
                - 'INVOICE': A sales invoice or request for payment sent to a customer.
                - 'STATEMENT': ONLY if it is a official Bank Statement, Credit Card Summary, or Transaction List from a financial institution.
                - 'UNKNOWN': If it is not a clear accounting document.

                IMPORTANT: If currency is not explicitly clear but context suggests Morocco, use "MAD".
                
                PAYMENT METHODS: Identify and map to: ['Cash', 'Bank Transfer', 'Credit/Debit Card', 'Cheque', 'Mobile Payment', 'Online Payment', 'Direct Debit', 'Deferred Payment', 'Instant Bank Transfer', 'PayPal', 'Other'].

                Return JSON: { "documentType": "EXPENSE"|"INVOICE"|"STATEMENT"|"UNKNOWN", "amount": 0.00, "currency": "MAD", "date": "YYYY-MM-DD", "entity": "Supplier/Client Name", "notes": "Brief description", "monthYear": "MM-YYYY", "payment_method": "String" }`
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
        currency: result.currency || 'MAD',
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
                                "STATUS (USER JUST WANTS THE LIVE DASHBOARD: looking for current balance, general status without specifying a month/year. e.g. 'Status', 'Balance', clicks 'Account Status' button), " + 
                                "REPORT (USER WANTS FILTERED HISTORICAL DATA: asking for summaries of specific months, years, or entities. ANY mention of the word 'Report', 'Summary', or a month name like 'March', 'Jan', 'Last Month', or a year like '2025' MUST be classified as REPORT. e.g. 'Report for Amazon', 'March summary', 'Total for last year'), " +
                                "EXPENSE (OUTFLOW/SPENDING: paid someone, purchase, receipt, cost. e.g. 'Paid Google 500', 'Spent 10', 'Amazon receipt', 'Phone bill'), " +
                                "INVOICE (INFLOW/INCOME: record a sale, bill a client, client paid you. e.g. 'Bill Client ABC 1000', 'Invoice for services', 'Sold product to X'), " +
                                "STATEMENT (wants to upload bank statements), " +
                                "ACCOUNTANT (wants to ask a question to their accountant), " +
                                "MENU (wants to start over, welcome message, cancel current task), " +
                                "UNKNOWN (none of the above). " +
                                "CRITICAL LOGIC: Mentions of 'March', 'December', or any month name ALWAYS mean REPORT. 'Paid [Someone]' is always an EXPENSE. 'Billed [Someone]' or 'Invoice to [Someone]' is always an INVOICE. " +
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

          const validIntents = ['STATUS', 'EXPENSE', 'INVOICE', 'STATEMENT', 'ACCOUNTANT', 'MENU', 'REPORT'];
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

  /**
   * FIELD VALIDATOR: Checks if a piece of text is "meaningful" for a specific field.
   * Prevents social chatter/noise from entering the database.
   */
  async validateFieldAI(text, type, phone = null, skipCooldown = false) {
    if (!this.openai || !text) return false;
    
    // Quick logic first: If looking for amount and we see digits, it's probably valid.
    if (type === 'AMOUNT' && /\d/.test(text)) return true;

    try {
        const prompts = {
            'AMOUNT': "Is this text a price or numeric value (e.g. 'Fifty', '20.00', '10k')? Return 'YES' or 'NO'.",
            'ENTITY': "Is this text a business name, brand, or person's name (e.g. 'Amazon', 'Mr. Smith', 'Taxi')? Return 'YES' or 'NO'. Note: If it's a social sentence like 'who are you', 'how are you', return 'NO'.",
            'CATEGORY': "Is this a valid business category? Return 'YES' or 'NO'."
        };

        const response = await this.openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: prompts[type] || "Check if this text is meaningful data for an accounting field. Return 'YES' or 'NO'." 
                },
                { role: "user", content: text }
            ],
            max_tokens: 5
        });

        const result = response.choices[0].message.content.trim().toUpperCase();
        
        // Log usage
        if (phone && response.usage) {
            await laravelService.logAiUsage(phone, "gpt-4o-mini", response.usage.prompt_tokens, response.usage.completion_tokens, skipCooldown);
        }

        return result === 'YES';
    } catch (error) {
        console.error('AI Field Validation Error:', error.message);
        return true; // Fallback to allowing it if AI fails
    }
  }

  /**
     * Parse a natural language report query to extract filters
     */
    async parseReportQuery(text, from) {
        console.log(`🤖 AI SENSING REPORT QUERY: "${text}"`);
        try {
            const prompt = `
            You are a professional accounting assistant. Extract reporting filters from the user's message.
            User Message: "${text}"
            Current Date: ${new Date().toISOString().split('T')[0]}

            RULES:
            1. DATE EXTRACTION (PRIORITY): If they mention a month (e.g. "March", "last month"), extract the month number (1-12). If they mention a year (e.g. "2026"), extract it.
            2. NEGATIVE CONSTRAINT: Month names (January-December) and Years (2025-2030) are NEVER entities. If you see "report for march", 'entityName' MUST be null.
            3. ENTITY EXTRACTION: If they mention a company, store, or person (e.g. "Amazon", "Restaurant"), extract it as 'entityName'. 
            4. DATATYPE: Determine if they are asking for 'expenses', 'invoices' (sales/income), or a 'general' summary.

            EXAMPLES:
            - "report for march" -> {"entityName": null, "month": 3, "year": null, "dataType": "general"}
            - "report for nitesh arya march" -> {"entityName": "Nitesh Arya", "month": 3, "year": null, "dataType": "general"}
            - "expenses for amazon" -> {"entityName": "Amazon", "month": null, "year": null, "dataType": "expenses"}
            - "status of restaurant" -> {"entityName": "Restaurant", "month": null, "year": null, "dataType": "general"}

            RETURN JSON ONLY:
            {
                "entityName": string | null,
                "month": number | null,
                "year": number | null,
                "dataType": "expenses" | "invoices" | "general"
            }
            `;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            });

            const result = JSON.parse(completion.choices[0].message.content);
            return result;
        } catch (error) {
            console.error('AI Report Query Parsing Error:', error);
            return { entityName: null, month: null, year: null, dataType: "general" };
        }
    }
}

module.exports = new AIService();
