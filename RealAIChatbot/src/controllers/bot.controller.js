const knowledgeService = require('../services/knowledge.service.js');
const aiService = require('../services/ai.service.js');
const whatsappService = require('../services/whatsapp.service.js');
const laravelService = require('../services/laravel.service.js');
const stateService = require('../services/state.service.js');
const storageService = require('../services/storage.service.js');
const { t } = require('../utils/i18n.js');
const logger = require('../utils/logger.js');
const path = require('path');

const processedMessages = new Set();
const MESSAGE_CACHE_LIMIT = 100;

class BotController {
    async handleIncomingMessage(req, res) {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages) return res.sendStatus(200);

        const message = messages[0];
        const messageId = message.id;

        // 0. Deduplication logic
        if (processedMessages.has(messageId)) {
            logger.debug(`♻️ Ignoring duplicate message: ${messageId}`);
            return res.sendStatus(200);
        }
        processedMessages.add(messageId);
        
        // Keep cache size manageable
        if (processedMessages.size > MESSAGE_CACHE_LIMIT) {
            const firstItem = processedMessages.values().next().value;
            processedMessages.delete(firstItem);
        }

        const from = message.from;
        const type = message.type;
        
        try {
            let state = stateService.getUserState(from);
            let draft = stateService.getDraft(from);
            const lang = state.lang || 'en';

            // 1. Language Onboarding Check
            if (!state.data.languageChosen && state.state !== 'AWAITING_LANGUAGE') {
                const profile = await laravelService.checkAuth(from);
                if (profile && (profile.bot_lang || profile.lang)) {
                    stateService.setLanguage(from, profile.bot_lang || profile.lang);
                    state.data.languageChosen = true;
                    stateService.setUserState(from, state.state, state.data);
                } else {
                    return this.promptLanguageSelection(from);
                }
            }

            // 2. Media Handler
            if (type === 'audio' || type === 'image' || type === 'document') {
                await this.handleMedia(from, message, state);
                return res.sendStatus(200);
            }

            // 3. Interactive / Button Handler
            if (type === 'interactive' || type === 'button') {
                await this.handleInteractive(from, message, state, draft);
                return res.sendStatus(200);
            }

            const text = message.text?.body || "";
            return this.processTextMessage(from, text, state);
        } catch (error) {
            logger.error("Controller Error:", error);
            if (!res.headersSent) res.sendStatus(500);
        }
    }

    async handleMedia(from, message, state) {
        const type = message.type;
        const lang = state.lang || 'en';
        const mediaId = message[type].id;
        const ext = type === 'audio' ? 'ogg' : (type === 'image' ? 'jpg' : 'pdf');
        
        await whatsappService.sendTextMessage(from, t('processing_media', lang, { type }));
        const localPath = await storageService.downloadMedia(mediaId, `${type}_${Date.now()}.${ext}`);

        if (type === 'audio') {
            const transcription = await aiService.transcribeAudio(localPath);
            if (transcription) {
                await whatsappService.sendTextMessage(from, `🎙️ _"${transcription}"_`);
                // Process the transcribed text as a normal message
                const pseudoMessage = { text: { body: transcription }, from, type: 'text' };
                return this.processTextMessage(from, transcription, state);
            } else {
                await whatsappService.sendTextMessage(from, "❌ Sorry, I couldn't understand the audio.");
            }
        } else if (state.state === 'AWAITING_STATEMENT_FILE' || type === 'document') {
            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath: localPath });
            await whatsappService.sendTextMessage(from, t('stmt_detected_pdf', lang));
        } else {
            const draft = stateService.getDraft(from);
            draft.filePath = localPath;
            stateService.updateDraft(from, draft);
            await whatsappService.sendTextMessage(from, t('linking_media', lang, { type }));
        }
    }

    async processTextMessage(from, text, state) {
        const draft = stateService.getDraft(from) || {};
        const lang = state.lang || 'en';
        const textLower = text.toLowerCase().trim();

        // 1. Global Interceptors
        if (['cancel', 'annuler', 'exit', 'stop', 'menu'].includes(textLower)) {
            stateService.clearUserState(from);
            stateService.updateDraft(from, {}); 
            await whatsappService.sendTextMessage(from, t('cancel_msg', lang));
            return this.sendWelcomeMenu(from, lang);
        }

        // 2. State-Based Shortcuts
        if (state.state.includes('CONFIRMATION')) {
            if (['yes', 'oui', 'confirm', 'ok'].includes(textLower)) {
                await this.executeFinalAction(from, state.state, draft);
                stateService.clearUserState(from);
                stateService.updateDraft(from, {}); 
                return;
            } else if (['edit', 'modifier', 'change'].includes(textLower)) {
                return this.sendEditSelectionButtons(from, lang);
            }
        }

        if (state.state.startsWith('AWAITING_EDIT_')) {
            const field = state.state.replace('AWAITING_EDIT_', '').toLowerCase();
            const fieldKey = field === 'entity' ? (draft.intent === 'INVOICE_CREATION' ? 'client_name' : 'supplier_name') : field;
            draft[fieldKey] = text;
            stateService.updateDraft(from, draft);
            stateService.setUserState(from, `AWAITING_${draft.intent || 'ACTION'}_CONFIRMATION`, state.data);
            await whatsappService.sendTextMessage(from, t('entry_updated', lang));
            return this.resendConfirmation(from, draft, lang);
        }

        if (state.state === 'AWAITING_STATEMENT_MONTH') {
            await whatsappService.sendTextMessage(from, t('uploading_stmt', lang, { monthYear: text }));
            try {
                await laravelService.uploadStatement(state.data.filePath, from, text);
                await whatsappService.sendTextMessage(from, t('stmt_uploaded_success', lang));
            } catch (e) { await whatsappService.sendTextMessage(from, "❌ Upload failed."); }
            return stateService.clearUserState(from);
        }

        // 3. AI Logic
        const knowledge = await knowledgeService.getUserKnowledge(from);
        const context = knowledgeService.formatForAI(knowledge);
        const aiRes = await aiService.processQuery(text, context, draft, lang);

        if (aiRes.lang_detected && aiRes.lang_detected !== lang) {
            stateService.setLanguage(from, aiRes.lang_detected);
        }

        let updatedDraft = draft;
        if (aiRes.extracted_data && Object.keys(aiRes.extracted_data).length > 0) {
            // CRITICAL: If the AI has found NEW data from a fresh message, 
            // we should clear out old "Notes/Reason" if they were from a different intent
            const isFreshStart = state.state === 'IDLE' || (draft.intent && aiRes.intent !== draft.intent);
            
            if (isFreshStart) {
                // Wipe the old draft so Mr Smith doesn't show up in McDonalds
                stateService.updateDraft(from, { ...aiRes.extracted_data, intent: aiRes.intent }, true);
                updatedDraft = stateService.getDraft(from);
            } else {
                stateService.updateDraft(from, aiRes.extracted_data);
                updatedDraft = stateService.getDraft(from);
            }
        }

        switch (aiRes.intent) {
            case 'STATUS_CHECK':
                await whatsappService.sendTextMessage(from, aiRes.response);
                break;
            case 'REPORT_REQUEST':
                await this.sendReportMenu(from, lang);
                break;
            case 'STATEMENT_UPLOAD_START':
                stateService.setUserState(from, 'AWAITING_STATEMENT_FILE');
                await whatsappService.sendTextMessage(from, t('prompt_stmt_general', lang));
                break;
            default:
                if (aiRes.action === 'CONFIRMATION_REQUIRED') {
                    stateService.setUserState(from, `AWAITING_${aiRes.intent}_CONFIRMATION`, state.data);
                    return this.resendConfirmation(from, updatedDraft, lang);
                } else {
                    await whatsappService.sendTextMessage(from, aiRes.response || "How else can I help?");
                }
        }
    }

    async handleInteractive(from, message, state, draft) {
        const interactive = (message.interactive && (message.interactive.button_reply || message.interactive.list_reply)) || message.button;
        const id = interactive?.id || interactive?.button_reply?.id || interactive?.list_reply?.id;
        const lang = state.lang || 'en';

        if (!id) return;

        if (id === 'confirm') {
            await this.executeFinalAction(from, state.state, draft);
            stateService.clearUserState(from);
            stateService.updateDraft(from, {});
        } else if (id === 'edit') {
            await this.sendEditSelectionButtons(from, lang);
        } else if (id === 'cancel') {
            stateService.clearUserState(from);
            await whatsappService.sendTextMessage(from, t('cancel_msg', lang));
            await this.sendWelcomeMenu(from, lang);
        } else if (id.startsWith('lang_')) {
            const chosen = id.replace('lang_', '');
            stateService.setLanguage(from, chosen);
            await laravelService.updateLanguage(from, chosen);
            await stateService.setUserState(from, 'IDLE', { languageChosen: true });
            await this.sendWelcomeMenu(from, chosen);
        } else if (id.startsWith('edit_')) {
            const field = id.replace('edit_', '');
            stateService.setUserState(from, `AWAITING_EDIT_${field.toUpperCase()}`, state.data);
            await whatsappService.sendTextMessage(from, t(`prompt_edit_${field}`, lang));
        } else if (id.startsWith('rep_')) {
            await this.handleReportSelection(from, id, lang);
        } else if (id === 'record_expense' || id === 'record_invoice') {
            stateService.setUserState(from, `AWAITING_${id.toUpperCase()}_INPUT`);
            await whatsappService.sendTextMessage(from, t(`prompt_${id.split('_')[1]}_general`, lang));
        } else if (id === 'status') {
            const stats = await laravelService.getAccountStatus(from, null, null, null, lang);
            await this.sendStatusInteractive(from, stats, lang);
        }

    }

    async handleReportSelection(from, id, lang) {
        if (id === 'rep_gen_month') {
            const stats = await laravelService.getAccountStatus(from, null, null, null, lang);
            await this.sendStatusInteractive(from, stats, lang);
        } else if (id === 'rep_gen_unpaid') {
            const stats = await laravelService.getAccountStatus(from, null, null, null, lang);
            if (stats.total_unpaid_sum > 0) {
                await whatsappService.sendTextMessage(from, t('alert_unpaid_total', lang, { total: stats.total_unpaid_sum, count: stats.invoicesCount }));
            } else {
                await whatsappService.sendTextMessage(from, t('alert_no_unpaid', lang, { count: stats.invoicesCount }));
            }
        } else if (id === 'rep_gen_search') {
            stateService.setUserState(from, 'AWAITING_REPORT_SEARCH');
            await whatsappService.sendTextMessage(from, t('prompt_search_name', lang));
        }
    }

    async sendReportMenu(from, lang) {
        const [clients, suppliers] = await Promise.all([
            laravelService.getClients(from),
            laravelService.getSuppliers(from)
        ]);

        const rowsGeneral = [
            { id: 'rep_gen_unpaid', title: t('btn_unpaid_invoices', lang) },
            { id: 'rep_gen_month', title: t('btn_monthly_summary', lang) },
            { id: 'rep_gen_search', title: t('btn_search_name', lang) }
        ];

        const sections = [{ title: t('section_general_reports', lang), rows: rowsGeneral }];
        if (clients.length > 0) {
            sections.push({ 
                title: t('section_recent_clients', lang), 
                rows: clients.slice(0, 3).map(c => ({ id: `rep_c_${c.id}`, title: (c.company_name || c.client_name).substring(0, 24) })) 
            });
        }

        await whatsappService.sendInteractiveList(from, t('report_select_title', lang), t('list_trigger_options', lang), sections);
    }

    async sendStatusInteractive(from, stats, lang) {
        if (!stats) return;
        
        const msg = `
📊 *${t('report_title', lang).toUpperCase()}*
_${stats.month || 'Current Status'}_
--------------------------------------------
💰 *${t('report_performance', lang)}*
• ${t('report_income', lang)}: *${stats.salesSum}*
• ${t('report_expenses', lang)}: *${stats.expensesSum}*

📈 *${t('report_balance', lang)}:*  *${stats.salesSum - stats.expensesSum}*

🏛️ *TAX SUMMARY*
• ${t('report_vat', lang)}: *${stats.vatPayable}*
--------------------------------------------
✅ _${t('report_ready', lang)}_
        `;
        await whatsappService.sendTextMessage(from, msg.trim());
    }

    async promptLanguageSelection(from) {
        await whatsappService.sendInteractiveButtons(from, t('welcome_language', 'en'), [
            { id: 'lang_en', title: "🇬🇧 English" },
            { id: 'lang_fr', title: "🇫🇷 Français" }
        ]);
    }

    async sendWelcomeMenu(from, lang) {
        await whatsappService.sendInteractiveButtons(from, t('welcome', lang), [
            { id: 'record_expense', title: t('btn_record_expense', lang) },
            { id: 'record_invoice', title: t('btn_record_invoice', lang) },
            { id: 'status', title: t('btn_status', lang) }
        ]);
    }

    async sendEditSelectionButtons(from, lang) {
        const sections = [
            {
                title: t('section_edit_fields', lang) || 'Fields to Modify',
                rows: [
                    { id: 'edit_amount', title: t('field_amount', lang) || 'Amount' },
                    { id: 'edit_entity', title: t('field_entity_client', lang) || 'Entity (Client/Supplier)' },
                    { id: 'edit_notes', title: t('field_notes', lang) || 'Notes/Reason' },
                    { id: 'edit_date', title: t('field_date', lang) || 'Date' }
                ]
            }
        ];
        await whatsappService.sendInteractiveList(from, 
            t('edit_selection_prompt', lang) || 'Select the field you wish to modify:', 
            'Edit Options', 
            sections
        );
    }

    async resendConfirmation(from, draft, lang) {
        const isInvoice = draft.intent === 'INVOICE_CREATION';
        const typeLabel = isInvoice ? '📄 INVOICE REVIEW' : '💸 EXPENSE REVIEW';
        const entityLabel = isInvoice ? '👤 *Client:*' : '🏢 *Supplier:*';
        const entityValue = draft.client_name || draft.supplier_name || draft.entity || 'General';
        const amount = draft.amount || draft.ttc || 0;
        const reason = draft.reason || draft.description || 'Professional Services';
        const notes = draft.notes || '';
        const date = draft.date || new Date().toISOString().split('T')[0];

        let summary = `
*${typeLabel}*
--------------------------------------------
${entityLabel}  *${entityValue}*
💰 *Amount:*   *${amount} MAD*
📝 *Reason:*   *${reason}*
📅 *Date:*     *${date}*
`;

        if (notes && notes !== reason) {
            summary += `📔 *Notes:*    _${notes}_\n`;
        }

        summary += `--------------------------------------------
*Shall I save this record?*
        `;
        
        await whatsappService.sendInteractiveButtons(from, summary.trim(), [
            { id: 'confirm', title: t('btn_confirm', lang) },
            { id: 'edit', title: t('btn_edit', lang) },
            { id: 'cancel', title: t('btn_cancel', lang) }
        ]);
    }

    async executeFinalAction(phone, state, draft) {
        const lang = stateService.getUserState(phone).lang;
        if (!draft || Object.keys(draft).length === 0) {
            await whatsappService.sendTextMessage(phone, "⚠️ Error: Draft lost.");
            return;
        }

        const isInvoice = state.toUpperCase().includes('INVOICE');
        const actionType = isInvoice ? 'invoice' : 'expense';
        
        await whatsappService.sendTextMessage(phone, `🚀 Recording ${actionType}...`);
        
        const res = isInvoice 
            ? await laravelService.createInvoice(draft, draft.filePath, phone)
            : await laravelService.createExpense(draft, draft.filePath, phone);

        if (res.success !== false) {
            const header = isInvoice ? '📄 *INVOICE RECORDED*' : '💸 *EXPENSE RECORDED*';
            const entityLabel = isInvoice ? '👤 *Client:*' : '🏢 *Supplier:*';
            const amountDisplay = `${draft.amount || 0} MAD`;
            const dateDisplay = draft.date || new Date().toISOString().split('T')[0];
            const finalNotes = draft.notes || draft.reason || draft.description || '';

            const summary = `
${header}
--------------------------------------------
${entityLabel} *${draft.client_name || draft.supplier_name || draft.entity}*
💰 *Amount:* *${amountDisplay}*
📅 *Date:* *${dateDisplay}*
📝 *Notes:* *${finalNotes}*
--------------------------------------------
✅ *Status:* Recorded Successfully
            `;
            
            await whatsappService.sendTextMessage(phone, summary.trim());
            stateService.clearUserState(phone);
        } else {
            const errorMsg = typeof res.errors === 'string' ? res.errors : (res.message || "Request failed");
            await whatsappService.sendTextMessage(phone, `❌ Error: ${errorMsg}`);
        }
    }
}

module.exports = new BotController();
