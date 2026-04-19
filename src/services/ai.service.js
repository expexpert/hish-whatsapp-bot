const { OpenAI } = require('openai');
const config = require('../config');
const fs = require('fs');
const laravelService = require('./laravel.service');
const logger = require('../utils/logger');


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
    logger.debug('Using OpenAI for NLP extraction...');

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
            content: `You are an accounting assistant specialized in both English and French bookkeeping. ${dateContext} Extract details from the user's message. ` + 
                      catList +
                      "PRIORITY 1: Match exactly or semantically with 'Available Categories' (e.g., if 'Food' is available, map 'Coffee'/'Cafe' to it). " +
                      "PRIORITY 2: If no match in your list, use COMMON MAPPINGS: 'Coffee', 'Lunch'/'Déjeuner' -> 'Meals & Entertainment'. 'Taxi', 'Uber', 'Fuel'/'Carburant' -> 'Travel & Transport'. 'Paper'/'Papier', 'Ink'/'Encre' -> 'Office Supplies'. " +
                      "PRIORITY 3: If no match found anywhere else, suggest a simple/logical new category. " +
                      "Do NOT create a NEW category if an existing one in 'Available Categories' is a reasonable match. Do NOT use 'General' or 'Other' if a better inference exists. " +
                      "Classify as 'EXPENSE' (receipt/reçu/justificatif), 'STATEMENT' (bank summary/relevé), or 'INVOICE' (sales/income/facture). " + 
                      "Extract the status of the document into 'status'. For invoices: ['Paid', 'Unpaid']. For expenses: ['Paid', 'Pending']. If the user does NOT explicitly mention the status (e.g. 'paid', 'paid', 'payé'), you MUST return null for 'status'. Do NOT guess. " +
                      "Extract the Supplier (for expenses) or Client (for invoices) name into 'entity'. Confidently extract the location or business name after prepositions like 'at', 'to', 'from', 'chez', 'à', 'de', 'pour', 'au', 'aux'. (e.g., 'chez amazon' -> 'Amazon'). " +
                      "CRITICAL: Only return 'Unknown' if there is absolutely no mention of a place or person. If a location is mentioned, use it. " +
                      "IMPORTANT: If the message starts with a command verb like 'Bill', 'Invoice', 'Facture', or 'Record' (e.g., 'Facturer 100 à...'), do NOT take that verb as the client name. " +
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
    // Regex Fallback logic...
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
        'Cash': [/cash/i, /paid in cash/i, /espèce/i, /liquide/i],
        'Bank Transfer': [/transfer/i, /bank/i, /wire/i, /virement/i, /eft/i],
        'Credit/Debit Card': [/card/i, /visa/i, /mastercard/i, /amex/i, /carte/i, /cb/i],
        'Cheque': [/cheque/i, /chèque/i],
        'Mobile Payment': [/mobile/i, /phone/i, /m-pesa/i, /orange money/i, /momo/i],
        'Online Payment': [/online/i, /web/i, /internet/i, /stripe/i, /en ligne/i],
        'Direct Debit': [/direct debit/i, /prélèvement/i, /auto-pay/i],
        'Deferred Payment': [/deferred/i, /later/i, /post-paid/i, /différé/i],
        'Instant Bank Transfer': [/instant/i, /faster payment/i, /virement instantané/i],
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

    // Extraction patterns (e.g., "at the museum", "to Amazon" or "chez Amazon", "à la banque")
    const entMatch = text.match(/(?:at|to|from|chez|à|de|pour|au|aux)\s+(?:the\s+)?([a-z0-9\s]+?)(?:\s+for|\s+on|\s+paid|$)/i);
    if (entMatch && entity === 'General') {
      entity = entMatch[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // Extract Month/Year for Statements (e.g. "April 2026" or "Mars 2026" or "04/2026")
    let monthYear = null;
    const monthYearRegex = /(?:january|february|march|april|may|june|july|august|september|october|november|december|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}/i;
    const monthYearMatch = text.match(monthYearRegex);
    if (monthYearMatch) {
      // For simplicity in regex fallback, we keep the found string or convert to a simple format if needed.
      // But to match AI, we should ideally convert to MM-YYYY.
      const rawMatch = monthYearMatch[0].toLowerCase();
      const monthMap = {
          'jan': '01', 'janv': '01', 'feb': '02', 'fév': '02', 'mar': '03', 'apr': '04', 'avr': '04', 'may': '05', 'mai': '05', 'jun': '06', 'jui': '06', 'jul': '07', 'aug': '08', 'aoû': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12', 'déc': '12'
      };
      const yearMatch = rawMatch.match(/\d{4}/);
      const year = yearMatch ? yearMatch[0] : new Date().getFullYear();
      let month = '01';
      for (const [key, val] of Object.entries(monthMap)) {
          if (rawMatch.includes(key)) { month = val; break; }
      }
      monthYear = `${month}-${year}`;
    } else {
      // Try MM/YYYY or MM-YYYY
      const mmYyyyRegex = /(\d{2})[/-](\d{4})/;
      const mmYyyyMatch = text.match(mmYyyyRegex);
      if (mmYyyyMatch) monthYear = `${mmYyyyMatch[1]}-${mmYyyyMatch[2]}`;
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
   async transcribeVoice(localFilePath, phone = null, skipCooldown = false, forcedLanguage = 'en') {
     if (this.openai && phone) {
       const status = await laravelService.checkAiStatus(phone, skipCooldown);
       if (!status.allowed) {
         throw new Error(status.message || "AI quota exceeded.");
       }
       return this.transcribeWithWhisper(localFilePath, phone, skipCooldown, forcedLanguage);
     }

    return this.mockTranscription(localFilePath);
  }

  /**
   * ADVANCED: OpenAI Whisper
   */
  async transcribeWithWhisper(localFilePath, phone = null, skipCooldown = false, forcedLanguage = 'en') {
    // Whisper Transcription logic...
    try {
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(localFilePath),
        model: "whisper-1",
        response_format: "verbose_json",
        language: forcedLanguage
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
                text: `You are an accounting assistant specialized in Moroccan bookkeeping (English and French). Today's Date is ${today}. Analyze this document. 
                Classify as:
                - 'EXPENSE': Any receipt, bill (reçu, ticket), or proof of payment.
                - 'INVOICE': A sales invoice (facture) or request for payment.
                - 'STATEMENT': ONLY bank statements (relevé bancaire).
                - 'UNKNOWN': Non-accounting documents.

                PRIORITIES: 
                1. Match categories exactly: ${catList}
                2. COMMON MAPPINGS: 'Coffee'/'Cafe' -> 'Food & Dining'. 'Uber'/'Taxi' -> 'Travel'.
                
                IMPORTANT: If currency is not clear but context is Morocco, use "MAD".
                STATUS: For invoices, use strictly ['Paid', 'Unpaid']. For expenses, use ['Paid', 'Pending']. If not visible, use null.
                PAYMENT METHODS: Strictly identify and map to one of: ['Cash', 'Bank Transfer', 'Credit/Debit Card', 'Cheque', 'Mobile Payment', 'Online Payment', 'Direct Debit', 'Deferred Payment', 'Instant Bank Transfer', 'PayPal', 'Other']. 
                IMPORTANT: If the payment method is NOT visible, return null. Do NOT guess. 
                IMPORTANT: For the 'date' field, only return a date if clearly visible. If not found, return null.

                Return JSON: { "documentType", "status", "amount", "vat", "currency", "category", "entity", "description", "monthYear", "payment_method", "date", "invoiceNumber" }`
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
      
      // Ensure all fields exist with disciplined defaults
      return {
        documentType: result.documentType || 'EXPENSE',
        status: result.status || null,
        amount: result.amount || 0,
        vat: result.vat || 0,
        currency: result.currency || 'MAD',
        category: result.category || 'Accounting',
        entity: result.entity || 'General',
        description: result.description || 'Processed via Vision AI',
        monthYear: result.monthYear || null,
        payment_method: result.payment_method || null,
        date: result.date || null,
        invoiceNumber: result.invoiceNumber || null
      };
    } catch (error) {
      console.error('Vision AI Error:', error.message);
      if (error.message.includes("quota exceeded")) throw error;
      return this.mockVision();
    }
  }

  mockVision() {
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
    if (!this.openai || !text) return { intent: 'UNKNOWN', lang: 'en' };
    
    try {
      if (phone) {
        const status = await laravelService.checkAiStatus(phone, skipCooldown);
        if (!status.allowed) return { intent: 'UNKNOWN', lang: 'en' };
      }

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: "Classify the user's intent into exactly ONE of these tokens: " +
                     "REPORT (FILTERED HISTORICAL DATA: summaries, months, years, totals, questions about money spent/earned, 'rapport', 'résumé', 'combien', 'combien j'ai payé'), " +
                     "EXPENSE (RECORDING NEW OUTFLOW: 'I paid', 'spent', 'receipt', 'payé [montant]', 'achat', 'reçu'), " + 
                     "INVOICE (RECORDING NEW INFLOW: 'bill', 'invoice', 'facture', 'vente', 'client paid'), " + 
                     "STATEMENT (upload bank statements, 'relevé'), " + 
                     "ACCOUNTANT (question to accountant, 'comptable'), " + 
                     "MENU (start over, 'annuler', 'quitter'), " + 
                     "UNKNOWN (none of the above). " + 
                     "CRITICAL LOGIC: If the user asks a question about totals (e.g., 'How much...', 'Combien...'), it is ALWAYS a REPORT. Mentions of months (March/Mars, Feb/Fév, etc.) ALWAYS mean REPORT. " +
                     "Detect lang: 'en' or 'fr'. " +
                     "Output JSON: { \"intent\": \"TOKEN\", \"lang\": \"en\"|\"fr\" }"
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      const intent = (result.intent || 'UNKNOWN').trim().toUpperCase();
      const lang = result.lang || 'en';
      
      logger.debug(`🤖 AI INTENT SENSING: "${text}" -> ${intent} (${lang})`);

      
      if (phone) {
        await laravelService.logAiUsage(phone, "gpt-4o-mini", response.usage.prompt_tokens, response.usage.completion_tokens, skipCooldown);
      }

      const validIntents = ['STATUS', 'EXPENSE', 'INVOICE', 'STATEMENT', 'ACCOUNTANT', 'MENU', 'REPORT'];
      return { 
        intent: validIntents.includes(intent) ? intent : 'UNKNOWN',
        lang: lang 
      };
    } catch (error) {
      console.error('AI Intent Classification Error:', error.message);
      return { intent: 'UNKNOWN', lang: 'en' };
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
                             "Support English and French month names (e.g., 'Mars 2026', 'January'). " +
                             "Standardize to 'MM-YYYY' format (e.g., '03-2026'). " +
                             "If the user says 'Last month' or 'Mois dernier', calculate it accurately based on today's date. " +
                             "If the user says 'Next week', 'Tomorrow', or anything that isn't a month, return 'Unknown'. " +
                             "Output exactly the standardized string (e.g. '04-2026') or 'Unknown' and nothing else." 
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
                "month": number (1-12) | null,
                "year": number | null,
                "dataType": "expenses" | "invoices" | "general"
            }
            Support English and French (e.g. "mars" -> month 3).
            IMPORTANT: Short month names like "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" MUST be extracted as months.
            If those words appear, do NOT include them in 'entityName'.
            "from Jan" -> month: 1, entityName: null.
            "summary for Raman Jan" -> entityName: "Raman", month: 1.
            "January 2026" -> month: 1, year: 2026.
            "this year" -> year: current year.
            "last month" -> month: previous month.
            "last year" -> year: previous year.
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
