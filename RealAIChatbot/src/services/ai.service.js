const { OpenAI } = require('openai');
const logger = require('../utils/logger.js');

class AIService {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    needsContext(text) {
        const triggers = ['report', 'invoice', 'expense', 'bill', 'client', 'supplier', 'money', 'how much', 'who', 'status', 'facture', 'depense', 'bilan', 'payer', 'reçu', 'recu', 'solde', 'tableau', 'compte', 'statut'];
        const lowerText = text.toLowerCase();
        return triggers.some(t => lowerText.includes(t)) || text.split(' ').length > 3;
    }

    async processQuery(text, knowledgeContext, currentDraft = null, systemLang = 'en') {
        const hasContext = this.needsContext(text) || (currentDraft && Object.keys(currentDraft).length > 0);
        const activeContext = hasContext ? knowledgeContext : "[]";

        const systemPrompt = `
        You are "Simply Compta AI", a smart accounting assistant.
        Language: ${systemLang === 'fr' ? 'French' : 'English'}
        CONTEXT: ${activeContext}
        DRAFT: ${JSON.stringify(currentDraft || {})}

        INTENTS & ACTIONS:
        1. DATA_EXTRACTION: If user provides info for an Expense or Invoice.
           - Extract: amount, company/person name, reason (designation).
           - Mapping: Match names to IDs (cl/sp) from Context.
           - Priority: If a numeric value is provided (e.g. "500"), it is ALWAYS the amount.
           - Mandatory: If [Name, Amount, Reason] are present, set "action": "CONFIRMATION_REQUIRED", "intent": "EXPENSE_CREATION" or "INVOICE_CREATION".

        2. STATUS_QUERY: If user asks for balance, status, or "how much I made".
           - Use "p" fields (rc, rp, ec, ep) from Context to summarize revenue/expenses.
           - Set "intent": "STATUS_CHECK".

        3. REPORT_QUERY: If user asks for a specific report or "show me invoices for Client X".
           - Identify entity and period.
           - Set "intent": "REPORT_REQUEST".

        4. STATEMENT_UPLOAD: If user mentions uploading a bank statement or PDF.
           - Set "intent": "STATEMENT_UPLOAD_START".

        5. GENERAL_HELP: If greetings or "what can you do".

        RESPONSE RULES:
        - Be concise and professional.
        - If confirming data: "I've prepared an [Expense/Invoice] for [Name] for [Amount] ([Reason]). Shall I save it?"
        - NEW NAMES: If you extract a name (Mr Smith) that isn't in the CONTEXT, do NOT send a separate warning. Just include it in the confirmation message.
        - If information is strictly missing (e.g., NO amount or NO supplier name provided at all), politely ask for the specific missing detail.
        - If status: "You have made [X] this month with [Y] in expenses."

        OUTPUT: YOU MUST RETURN ONLY A JSON OBJECT.
        JSON_STRUCTURE: { "response": "string", "intent": "string", "action": "CONFIRMATION_REQUIRED"|null, "extracted_data": {}, "lang_detected": "en"|"fr" }
        `;

        try {
            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: text }
                ],
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            console.log("🤖 [AI DEBUG]:", content);
            
            const parsed = JSON.parse(content);
            return parsed;
        } catch (error) {
            console.error("AI Error:", error);
            return { response: "Technical issue, one moment...", intent: "CHAT" };
        }
    }
    async transcribeAudio(filePath) {
        try {
            const fs = require('fs');
            const transcription = await this.openai.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: "whisper-1",
            });
            return transcription.text;
        } catch (error) {
            console.error("Transcription Error:", error);
            return null;
        }
    }
}

module.exports = new AIService();
