const path = require('path');
const whatsappService = require('../services/whatsapp.service');
const aiService = require('../services/ai.service');
const storageService = require('../services/storage.service');
const laravelService = require('../services/laravel.service');
const stateService = require('../services/state.service');
const config = require('../config');
const fs = require('fs');
const { t } = require('../utils/i18n');
const logger = require('../utils/logger');


class WhatsAppController {
  constructor() {
    this.processedMessageIds = new Set();
    this.userQueues = new Map(); // Per-user message queue
    // Periodically clear old IDs to prevent memory leak
    setInterval(() => this.processedMessageIds.clear(), 3600000); // Every hour
  }

  /**
   * String similarity helper (Dice's Coefficient / Bigram)
   * Returns a score between 0.0 and 1.0
   */
  calculateSimilarity(str1, str2) {
      if (!str1 || !str2) return 0;
      const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
      const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      if (s1 === s2) return 1.0;
      if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1.0 : 0;
      
      const getBigrams = (s) => {
          const bigrams = new Set();
          for (let i = 0; i < s.length - 1; i++) {
              bigrams.add(s.substring(i, i + 2));
          }
          return bigrams;
      };
      
      const b1 = getBigrams(s1);
      const b2 = getBigrams(s2);
      
      let intersect = 0;
      for (const b of b1) {
          if (b2.has(b)) intersect++;
      }
      
      return (2.0 * intersect) / (b1.size + b2.size);
  }
  
  async verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
        return res.status(200).send(challenge);
      } else {
        return res.status(403).send('Forbidden');
      }
    }
    res.status(400).send('Bad Request');
  }

  async handleWebhookEvent(req, res) {
    const body = req.body;
    logger.debug('📬 NEW WEBHOOK EVENT RECEIVED', body);


    if (body.object === 'whatsapp_business_account' && body.entry) {
      // 1. Respond 200 OK immediately to stop Meta from retrying
      res.status(200).send('EVENT_RECEIVED');

      // 2. Process events in the background
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          const value = change.value;
          if (value.messages) {
            for (const message of value.messages) {
              // 3. Deduplication
              if (this.processedMessageIds.has(message.id)) {
                continue;
              }
              this.processedMessageIds.add(message.id);
              
              // 4. Sequential Queueing per User
              const from = message.from;
              if (!this.userQueues.has(from)) {
                this.userQueues.set(from, Promise.resolve());
              }

              const currentQueue = this.userQueues.get(from);
              const nextInQueue = currentQueue.then(async () => {
                try {
                  await this.processMessage(message);
                } catch (err) {
                  console.error(`❌ ERROR PROCESSING MESSAGE ${message.id} for ${from}:`, err);
                }
              });

              this.userQueues.set(from, nextInQueue);
              
              // Cleanup queue reference when finished to prevent memory leaks
              nextInQueue.finally(() => {
                if (this.userQueues.get(from) === nextInQueue) {
                  this.userQueues.delete(from);
                }
              });
            }
          }
        }
      }
      return;
    }
    res.status(404).send('Not Found');
  }

  async processMessage(message) {
    try {
      const from = message.from;
      logger.debug(`📥 Incoming message from: "${from}"`);


      // 0. Global Activation Check
      let isAuth = config.bypassAuth === true;
      
      if (!isAuth) {
        // 1. Check if we are in a back-off period (Negative Cache)
        if (stateService.isBlocked(from)) {
          return; // Exit silently during back-off
        }

        // 2. Check cache first
        const cachedAuth = stateService.getAuthStatus(from);
        if (cachedAuth !== null) {
          isAuth = cachedAuth;
        } else {
          isAuth = await laravelService.checkAuth(from);
          if (isAuth) {
            stateService.setAuthStatus(from, true);
          } else {
            // Failure! Back-off for 30s
            stateService.setBlockedStatus(from);
          }
        }
      }

      if (!isAuth) {
          const state = await stateService.getUserState(from);
          const now = Date.now();
          const cooldown = 15 * 60 * 1000; // 15 minutes

          if (now - (state.lastWarned || 0) > cooldown) {
              await whatsappService.sendTextMessage(from, t('auth_required', state.lang));
              stateService.setLastWarned(from, now);
          }
          return;
      }

      const type = message.type;
      const state = await stateService.getUserState(from);
      
      let text = '';
      let interactiveId = null;

      let audioPath = null;
      // 1. Transcription Handler (Voice notes)
      if (type === 'audio') {
        try {
          const extension = 'ogg';
          audioPath = await storageService.downloadMedia(message.audio.id, `audio_${Date.now()}.${extension}`);
          const transcription = await aiService.transcribeVoice(audioPath, from, false, state.lang);
          
          if (transcription) {
            text = transcription.trim();
            logger.debug(`🎙️ AUDIO TRANSCRIPTION: "${text}"`);

            
            // Link the audio file as proof if we are in the middle of a task
            if (state.state !== 'IDLE') {
                const dataKey = state.state.includes('INVOICE') ? 'filePath' : 'receiptPath';
                state.data[dataKey] = audioPath;
            }
          }
        } catch (error) {
          console.error('🎙️ Transcription error:', error.message);
        }
      }

      // 2. Text/Interactive/Button Handler
      if (type === 'text' || type === 'interactive' || type === 'button' || type === 'audio') {
        if (type === 'text') {
          text = message.text.body.trim();
        } else if (type === 'interactive' && message.interactive.type === 'button_reply') {
          text = message.interactive.button_reply.title.trim();
          interactiveId = message.interactive.button_reply.id;
        } else if (type === 'interactive' && message.interactive.type === 'list_reply') {
          text = message.interactive.list_reply.title.trim();
          interactiveId = message.interactive.list_reply.id;
        } else if (type === 'button') {
          text = message.button.text.trim();
        }

        if (!text) return;

        const textLower = text.toLowerCase();
        const isInteractive = type === 'interactive';
        if (!interactiveId && isInteractive && message.interactive) {
          interactiveId = message.interactive.button_reply?.id || message.interactive.list_reply?.id;
        }

        const isConfirm = interactiveId === 'confirm' || 
                         ['confirm', 'confirmer', 'ok', 'yes', 'oui', 'save', 'enregistrer'].includes(textLower);
        const isEdit = interactiveId === 'edit' || 
                      ['edit', 'modifier', 'change', 'corriger'].includes(textLower);
        const isCancel = interactiveId === 'cancel' || 
                        ['cancel', 'annuler', 'stop', 'quitter', 'menu'].includes(textLower);
        
        // --- GLOBAL INTENT INTERCEPTOR (Allows switching at ANY time) ---
        const primaryIntents = {
            'status': { keywords: ['status', 'dashboard', 'balance', 'statut', 'solde', 'tableau', 'compte'], id: 'status' },
            'expense': { keywords: ['expense', 'record expense', 'new expense', 'add expense', 'record voice', 'audio note', 'paid', 'spent', 'receipt', 'purchase', 'dépense', 'payé', 'achat', 'reçu'], id: 'record_expense' },
            'invoice': { keywords: ['invoice', 'record invoice', 'new invoice', 'add invoice', 'bill', 'client', 'sale', 'sold', 'facture', 'vente'], id: 'record_invoice' },
            'statement': { keywords: ['statement', 'upload statement', 'bank statement', 'upload', 'pdf', 'relevé', 'banque', 'télécharger'], id: 'upload_statement' },
            'reports_menu': { keywords: ['reports', 'quick reports', 'rapports'], id: 'quick_reports' },
            'report': { keywords: ['report', 'how much', 'total', 'summary', 'show me', 'rapport', 'résumé', 'combien', 'période', 'mars', 'avril', 'janvier', 'janv', 'mars', 'déc'], id: 'report' },
            'accountant': { keywords: ['ask accountant', 'contact accountant', 'talk to accountant', 'comptable'], id: 'ask_accountant' },
            'menu': { keywords: ['menu', 'start', 'home', 'main menu', 'exit', 'cancel', 'stop', 'quit', 'bonjour', 'salut', 'coucou', 'début', 'annuler'], id: 'menu' }
        };

        let detectedIntent = null;
        const isShortMessage = text.split(' ').length <= 2;

        // --- PRIORITY PROTECTION FOR FRENCH FLOW ---
        // Prevents "Modifier" (Edit) or "Confirmer" from being misclassified 
        // by AI as a "New Expense/Invoice" intent, which would clear the state.
        const isCoreFrenchAction = state.lang === 'fr' && (isEdit || isConfirm || isCancel);
        
        if (textLower.startsWith('how much') || textLower.startsWith('combien') || textLower.startsWith('rapport') || 
            textLower.includes('summary') || textLower.includes('résumé') || 
            ((textLower.includes('statement') || textLower.includes('relevé')) && (textLower.includes('for') || textLower.includes('pour') || textLower.includes('from') || textLower.includes('de')))) {
            detectedIntent = 'report';
        } else if (isCoreFrenchAction && state.state !== 'IDLE') {
            detectedIntent = null; // Prioritize local state handling over global intent interceptor
            logger.debug(`🛡️ FRENCH CORE ACTION DETECTED (${text}): Bypassing global intent detection.`);
        } else if (interactiveId === 'quick_reports') {
            // Force priority for exact menu button interactions to avoid NLP regex conflicts
            detectedIntent = 'reports_menu';
        } else {
            for (const [intent, config] of Object.entries(primaryIntents)) {
                // STRICTER CHECK: Only trigger intent switches if:
                // 1. Interactive ID matches exactly (Best)
                // 2. Text matches exactly (Very Safe)
                // 3. Text includes keyword BUT ONLY if state is IDLE (Safe)
                const isExactMatch = textLower === intent || config.keywords.some(k => textLower === k);
                const isButtonMatch = interactiveId === config.id;
                const isIdleInclude = state.state === 'IDLE' && config.keywords.some(k => textLower.length > 5 && textLower.includes(k));

                if (isButtonMatch || isExactMatch || isIdleInclude) {
                    detectedIntent = intent;
                    break;
                }
            }
        }

        // --- NEW: AI INTENT & LANGUAGE SENSING ---
        // Triggered for natural language sentences to detect intent and language
        if ((!detectedIntent || text.split(' ').length > 2) && !isCoreFrenchAction && (type === 'text' || type === 'audio') && state.state === 'IDLE') {
            const greetings = ['hi', 'hello', 'hey', 'bonjour', 'salam', 'ola', 'ça va', 'ca va'];
            if (!greetings.includes(textLower)) {
                // Returns { intent, lang }
                const aiResult = await aiService.classifyIntent(text, from, true);
                
                // --- UPDATE LANGUAGE ---
                if (aiResult.lang && aiResult.lang !== state.lang) {
                    stateService.setLanguage(from, aiResult.lang);
                    state.lang = aiResult.lang; // Update local reference
                }

                // If keywords didn't find anything, let AI set the intent
                if (!detectedIntent && aiResult.intent && aiResult.intent !== 'UNKNOWN' && aiResult.intent !== 'MENU') {
                    detectedIntent = aiResult.intent.toLowerCase();
                    logger.debug(`🤖 AI SENSING OVERRIDE: -> ${detectedIntent}`);
                }
            } else {
                // Greetings trigger welcome menu in current language
                if (textLower === 'bonjour' || textLower === 'ça va' || textLower === 'ca va') {
                    stateService.setLanguage(from, 'fr');
                    state.lang = 'fr';
                }
            }
        }

        // Handle global quick report selections (Exclude during active sub flows)
        if (interactiveId && interactiveId.startsWith('rep_') && 
            state.state !== 'AWAITING_REPORT_DISAMBIGUATION' && 
            state.state !== 'AWAITING_REPORT_PERIOD') {
             await this.handleReportMenuSelection(from, interactiveId);
             return;
        }

        // --- NEW: Handle Dashboard PDF/Media Deliveries ---
        if (interactiveId && (interactiveId.startsWith('v_inv_') || interactiveId.startsWith('v_exp_'))) {
            const type = interactiveId.startsWith('v_inv_') ? 'inv' : 'exp';
            const id = interactiveId.replace('v_inv_', '').replace('v_exp_', '');
            await this.handleDeliverSpecificMedia(from, type, id);
            return;
        }

        // --- NEW: Handle Dynamic List Selections ---
        if (interactiveId && (interactiveId.startsWith('list_inv_') || interactiveId.startsWith('list_exp_'))) {
            const parts = interactiveId.split('_');
            const type = parts[1]; // inv or exp
            const entityId = parts[2];
            const month = parts[3] === '00' ? null : parseInt(parts[3]);
            const year = parts[4] === '0000' ? null : parseInt(parts[4]);
            
            await this.handleListTransactions(from, type, entityId, month, year);
            return;
        }

        // --- NEW: Handle Dynamic Record Selections (Context-Aware) ---
        if (interactiveId && (interactiveId.startsWith('record_exp_') || interactiveId.startsWith('record_inv_'))) {
            const parts = interactiveId.split('_');
            const typeValue = parts[1]; // exp or inv
            const entityId = parts[2];
            
            // Look up entity name for a better UX
            let entityName = "Selection";
            if (typeValue === 'exp') {
                const suppliers = await laravelService.getSuppliers(from);
                const supplier = suppliers.find(s => s.id == entityId);
                if (supplier) entityName = supplier.name;
            } else {
                const clients = await laravelService.getClients(from);
                const client = clients.find(c => c.id == entityId);
                if (client) entityName = client.company_name || client.client_name;
            }

            stateService.clearUserState(from);
            
            if (typeValue === 'exp') {
                stateService.setUserState(from, 'AWAITING_EXPENSE_DATA', { 
                    expenseData: { entity: entityName, supplier_id: entityId } 
                });
                await whatsappService.sendTextMessage(from, t('prompt_expense', state.lang, { entity: entityName }));
            } else {
                stateService.setUserState(from, 'AWAITING_INVOICE_DATA', { 
                    invoiceData: { client_name: entityName, client_id: entityId } 
                });
                await whatsappService.sendTextMessage(from, t('prompt_invoice', state.lang, { entity: entityName }));
            }
            return;
        }

        if (detectedIntent) {
            logger.debug(`🎯 DETECTED INTENT: ${detectedIntent} (Current State: ${state.state})`);

            
            // FIX: Prevent recursive prompting loops and allow direct data entry
            // If already in the flow OR if the message follows a data-like pattern (longer than 2 words),
            // skip the re-triggering of prompts and let the parser handle it.
            const isReTrigger = (detectedIntent === 'expense' && state.state === 'AWAITING_EXPENSE_DATA') ||
                                (detectedIntent === 'invoice' && state.state === 'AWAITING_INVOICE_DATA') ||
                                (detectedIntent === 'statement' && state.state === 'AWAITING_STATEMENT_DATA');
            
            const isDirectData = (type === 'text' || type === 'audio') && text.split(' ').length > 2 && (detectedIntent === 'expense' || detectedIntent === 'invoice');

            if ((isReTrigger || isDirectData) && (type === 'text' || type === 'audio' || type === 'voice')) {
                logger.debug(`♻️ RE-TRIGGER OR DIRECT DATA: Skipping intent reset to allow parsing logic to take over.`);

                // We fall through to the parsing logic below
            } else {
                // If switching to a new major task or triggering via button, clear the old state first
                stateService.clearUserState(from);

                switch (detectedIntent) {
                    case 'menu':
                        await this.sendWelcomeMenu(from);
                        return;
                    case 'status':
                        if (type === 'text' || type === 'audio') {
                            return this.handleReportQuery(from, text);
                        }
                        await whatsappService.sendTextMessage(from, t('fetching_status', state.lang));
                        const stats = await laravelService.getAccountStatus(from);
                        await this.sendStatusInteractive(from, stats);
                        return;
                    case 'expense':
                        stateService.setUserState(from, 'AWAITING_EXPENSE_DATA');
                        await whatsappService.sendTextMessage(from, t('prompt_expense_general', state.lang));
                        return;
                    case 'invoice':
                        stateService.setUserState(from, 'AWAITING_INVOICE_DATA');
                        await whatsappService.sendTextMessage(from, t('prompt_invoice_general', state.lang));
                        return;
                    case 'statement':
                        stateService.setUserState(from, 'AWAITING_STATEMENT_DATA');
                        await whatsappService.sendTextMessage(from, t('prompt_stmt_general', state.lang));
                        return;
                    case 'accountant':
                        await this.handleAccountantQuery(from);
                        return;
                    case 'reports_menu':
                        await this.sendReportMenu(from);
                        return;
                    case 'report':
                        await this.handleReportQuery(from, text);
                        return;
                }
            }
        } else if (state.state === 'IDLE' || text.split(' ').length > 2) {
            // --- AI INTENT FALLBACK ---
            const aiResult = await aiService.classifyIntent(text, from, true);
            const aiIntent = aiResult.intent;

            if (aiIntent !== 'UNKNOWN' && aiIntent !== 'MENU') {
                // Check and update language if AI detected a switch
                if (aiResult.lang && aiResult.lang !== state.lang) {
                    stateService.setLanguage(from, aiResult.lang);
                    state.lang = aiResult.lang;
                }

                const isMatchingFlow = (aiIntent === 'EXPENSE' && state.state.includes('EXPENSE')) ||
                                       (aiIntent === 'INVOICE' && state.state.includes('INVOICE')) ||
                                       (aiIntent === 'STATEMENT' && state.state.includes('STATEMENT'));
                
                if (!isMatchingFlow) {
                  stateService.clearUserState(from);
                }
                
                if (aiIntent === 'STATUS') {
                    return this.handleReportQuery(from, text);
                } else if (aiIntent === 'EXPENSE' || aiIntent === 'INVOICE') {
                    // These will be handled by the direct data entry parser below
                    // Just let them continue, but ensure we don't fall through to menu
                } else if (aiIntent === 'ACCOUNTANT') {
                    await this.handleAccountantQuery(from);
                    return;
                } else if (aiIntent === 'REPORT') {
                    await this.handleReportQuery(from, text);
                    return;
                }
            }
        }

        // Check for 'Back to Main Menu' / Greetings
        const greetings = ['hi', 'hello', 'hey', 'menu', 'main menu', 'back to main menu'];
        if (greetings.includes(textLower)) {
          stateService.clearUserState(from);
          await this.sendWelcomeMenu(from);
          return;
        }

        // Check for Confirmation/Edit state
        if (state.state === 'AWAITING_EXPENSE_CONFIRMATION') {
          if (isConfirm) {
            const result = await laravelService.createExpense(state.data.expenseData, state.data.receiptPath, from);
            let feedback = t('record_saved_success', state.lang);
            
            if (state.data.receiptPath) {
              const fileName = path.basename(state.data.receiptPath);
              const isAudio = fileName.endsWith('.ogg');
              
              if (!isAudio) {
                feedback += "\n" + t('sync_success_msg', state.lang);
                
                // Use signed URL if available, else fallback safely
                if (result.data && (result.data.download_url || result.data.id)) {
                  const downloadUrl = result.data.download_url || `${laravelService.publicUrl}/api/bot/file/${result.data.id}`;
                  logger.debug('🔗 GENERATED DOWNLOAD URL', { downloadUrl });
                  logger.debug(`💸 [INFO] Delivering Expense Receipt: ${downloadUrl}`);
                  
                  if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                  }

                  feedback += `\n\n---\n📥 *${t('open_receipt', state.lang).toUpperCase()}*\n${downloadUrl}`;
                  
                  // Also send as a proper Document Attachment for better UX
                  const extension = result.data.document_path ? path.extname(result.data.document_path) : '.pdf';
                  const filename = `Receipt_${result.data.id || 'Draft'}${extension}`;
                  await whatsappService.sendDocument(from, downloadUrl, filename);
                } else {
                  let finalUrl = result.file_url || `${config.botPublicUrl}/storage/${fileName}`;
                  feedback += `\n\n---\n📸 *${t('image_attached', state.lang).toUpperCase()}*\n${finalUrl}`;
                }
              } else {
                feedback += "\n" + t('voice_processed_msg', state.lang);
              }
            } else {
              feedback += "\n" + t('accountant_notified_msg', state.lang);
            }
            
            await whatsappService.sendTextMessage(from, feedback);
            stateService.clearUserState(from);
          } else if (isEdit) {
            stateService.setUserState(from, 'AWAITING_EDIT_SELECT', state.data);
            await this.sendEditSelectionButtons(from);
          } else if (isCancel) {
            stateService.clearUserState(from);
            await whatsappService.sendTextMessage(from, t('cancel_msg', state.lang));
            await this.sendWelcomeMenu(from);
          } else {
            await whatsappService.sendTextMessage(from, t('prompt_confirm_link', state.lang));
          }
          return;
        }
        
        if (state.state === 'AWAITING_REPORT_SEARCH' && (isInteractive || !detectedIntent)) {
            return this.handleReportQuery(from, text);
        }

        if (state.state === 'AWAITING_REPORT_PERIOD' && (isInteractive || !detectedIntent)) {
            const period = interactiveId || textLower;
            
            // Handle Custom Search Transition
            if (period === 'rep_period_custom') {
                stateService.setUserState(from, 'AWAITING_REPORT_CUSTOM_PERIOD', state.data);
                return whatsappService.sendTextMessage(from, t('prompt_report_period', state.lang));
            }

            let month = null;
            let year = null;
            
            if (period.includes('this') || period === 'rep_period_this') {
                month = new Date().getMonth() + 1;
                year = new Date().getFullYear();
            } else if (period.includes('last') || period === 'rep_period_last') {
                let d = new Date();
                d.setMonth(d.getMonth() - 1);
                month = d.getMonth() + 1;
                year = d.getFullYear();
            }
            
            const filters = { month, year };
            const isClient = state.data.isClient;
            const entity = state.data.entity;
            
            if (entity) {
                stateService.clearUserState(from);
                await this.sendFilteredReport(from, entity, isClient, filters);
            } else {
                stateService.clearUserState(from);
                await whatsappService.sendTextMessage(from, t('error_lost_track', state.lang));
            }
            return;
        }

        if (state.state === 'AWAITING_REPORT_CUSTOM_PERIOD' && !detectedIntent) {
            // Use NLP parser to extract month even though we are in a state
            const filters = await aiService.parseReportQuery(text, from);
            const isClient = state.data.isClient;
            const entities = isClient ? await laravelService.getClients(from) : await laravelService.getSuppliers(from);
            const entity = entities.find(e => e.id == state.data.entityId);

            if (entity && (filters.month || filters.year)) {
                await this.sendFilteredReport(from, entity, isClient, filters);
                stateService.clearUserState(from);
            } else {
                await whatsappService.sendTextMessage(from, t('error_invalid_date', state.lang));
            }
            return;
        }

        // --- Handle Report Disambiguation ---
        if (state.state === 'AWAITING_REPORT_DISAMBIGUATION') {
            if (interactiveId && interactiveId.startsWith('rep_')) {
                return this.handleReportDisambiguation(from, interactiveId, state);
            }
        }

        // --- Handle Invoice Confirmation ---
        if (state.state === 'AWAITING_INVOICE_CONFIRMATION') {
          if (isConfirm) {
                logger.debug('🚀 INVOICE CONFIRMATION START', { invoiceData: state.data.invoiceData });
                
                const result = await laravelService.createInvoice(state.data.invoiceData, state.data.filePath, from);
                logger.debug('🧾 LARAVEL RESPONSE RECEIVED', result);
                
                // Laravel returns the signed URL in 'download_url'
                if (result.data && (result.data.download_url || result.data.pdf_url || result.data.id)) {
                    let downloadUrl = result.data.download_url || result.data.pdf_url || `${laravelService.publicUrl}/api/bot/invoice/pdf/${result.data.id}`;
                    
                    // Defensive: Ensure we are not sending a localhost URL to Meta
                    if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                    }
                    
                    // 1. Deliver the document with a rich Professional Caption
                    try {
                        const date = result.data.date ? new Date(result.data.date).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB') : 'N/A';
                        const amount = parseFloat(result.data.total_ttc || result.data.amount || 0);
                        const currency = result.data.currency || 'MAD';
                        const fmtAmount = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + currency;
                        const entityName = result.data.client_name || result.data.entity || 'N/A';

                        const successText = `🧾 *${t('invoice_recorded_header', state.lang)}*\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `🏢 *${t('field_entity_client', state.lang)}:* ${entityName}\n` +
                                            `💰 *${t('field_amount', state.lang)}:* ${fmtAmount}\n` +
                                            `📅 *${t('field_date', state.lang)}:* ${date}\n` +
                                            `📝 *${t('field_notes', state.lang)}:* ${result.data.description || 'N/A'}\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `✅ *Status:* ${t('recorded_successfully', state.lang)}`;

                        const isPdfRoute = downloadUrl.includes('/pdf');
                        const isImage = result.data.document_path && (
                            result.data.document_path.toLowerCase().endsWith('.jpg') || 
                            result.data.document_path.toLowerCase().endsWith('.jpeg') || 
                            result.data.document_path.toLowerCase().endsWith('.png')
                        );
                        
                        let waResult;
                        if (!isPdfRoute && isImage) {
                            // If it's explicitly an image and NOT a generated PDF route
                            waResult = await whatsappService.sendImage(from, downloadUrl, successText);
                        } else {
                            // Otherwise send as document with dynamic extension
                            const extension = result.data.document_path ? path.extname(result.data.document_path) : '.pdf';
                            const filename = `Invoice_${result.data.id || 'Draft'}${extension}`;
                            waResult = await whatsappService.sendDocument(from, downloadUrl, filename, successText);
                        }
                    } catch (waErr) {
                        // Fallback only if media fails
                        await whatsappService.sendTextMessage(from, "✅ *Invoice Recorded Successfully*");
                    }
                } else {
                    await whatsappService.sendTextMessage(from, "✅ *Invoice Recorded Successfully*");
                }
                
                // 2. Clear state and show menu
                // We use a longer delay (2.5s) to ensure the PDF arrives before the menu
                stateService.clearUserState(from);
                await new Promise(resolve => setTimeout(resolve, 2500)); 
                await this.sendWelcomeMenu(from);
            } else if (isEdit) {
                stateService.setUserState(from, 'AWAITING_EDIT_SELECT_INVOICE', state.data);
                await this.sendEditSelectionButtons(from, 'INVOICE');
            } else if (isCancel) {
                stateService.clearUserState(from);
                await whatsappService.sendTextMessage(from, t('cancel_msg', state.lang));
                await this.sendWelcomeMenu(from);
            } else {
                await whatsappService.sendTextMessage(from, t('prompt_confirm_link', state.lang));
            }
            return;
        }

        // Check for Edit Selection state
        if (state.state === 'AWAITING_EDIT_SELECT' || state.state === 'AWAITING_EDIT_SELECT_INVOICE') {
          const isInvoice = state.state === 'AWAITING_EDIT_SELECT_INVOICE';
          const nextStateSuffix = isInvoice ? '_INVOICE' : '';

          if (interactiveId === 'amt' || textLower === 'amount') {
            stateService.setUserState(from, 'AWAITING_AMOUNT_EDIT' + nextStateSuffix, state.data );
            await whatsappService.sendTextMessage(from, t('prompt_edit_amount', state.lang));
          } else if (interactiveId === 'ent' || textLower === 'entity' || textLower === 'client') {
            if (isInvoice) {
                const clients = await laravelService.getClients(from);
                if (clients && clients.length > 0) {
                    stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', state.data);
                    await this.sendClientSelectionList(from, clients);
                } else {
                    stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', state.data);
                    await whatsappService.sendTextMessage(from, t('prompt_no_clients', state.lang));
                }
            } else {
                const suppliers = await laravelService.getSuppliers(from);
                if (suppliers && suppliers.length > 0) {
                    stateService.setUserState(from, 'AWAITING_EXPENSE_ENTITY', state.data);
                    await this.sendSupplierSelectionList(from, suppliers);
                } else {
                    stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', state.data);
                    await whatsappService.sendTextMessage(from, t('prompt_no_suppliers', state.lang));
                }
            }
          } else if (interactiveId === 'date' || textLower === 'date') {
            stateService.setUserState(from, (isInvoice ? 'AWAITING_DATE_EDIT_INVOICE' : 'AWAITING_DATE_EDIT'), state.data );
            await whatsappService.sendTextMessage(from, t('prompt_edit_date', state.lang));
          } else if (interactiveId === 'pay' || textLower === 'payment via') {
            stateService.setUserState(from, (isInvoice ? 'AWAITING_PAYMENT_METHOD_EDIT_INVOICE' : 'AWAITING_PAYMENT_METHOD_EDIT'), state.data );
            await this.sendPaymentMethodSelectionList(from, isInvoice ? 'INVOICE' : 'EXPENSE');
          } else if (interactiveId === 'cat' || textLower === 'category') {
            if (isInvoice) {
                stateService.setUserState(from, 'AWAITING_CATEGORY_EDIT_INVOICE', state.data);
                await whatsappService.sendTextMessage(from, t('prompt_edit_category', state.lang));
            } else {
                const categories = await laravelService.getCategories(from);
                stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', state.data);
                await this.sendCategorySelectionList(from, categories);
            }
          } else if (interactiveId === 'desc' || textLower === 'description' || textLower === 'notes') {
            stateService.setUserState(from, 'AWAITING_DESCRIPTION_EDIT' + nextStateSuffix, state.data);
            await whatsappService.sendTextMessage(from, t('prompt_edit_notes', state.lang));
          } else if (interactiveId === 'all' || textLower === 're-submit entry') {
            stateService.setUserState(from, 'IDLE');
            await whatsappService.sendTextMessage(from, t('prompt_edit_details', state.lang));
          }
          return;
        }

        if (state.state === 'AWAITING_AMOUNT_EDIT' || state.state === 'AWAITING_DESCRIPTION_EDIT' || 
            state.state === 'AWAITING_CATEGORY_EDIT' || state.state === 'AWAITING_ENTITY_EDIT' ||
            state.state === 'AWAITING_PAYMENT_METHOD_EDIT' ||
            state.state === 'AWAITING_AMOUNT_EDIT_INVOICE' || state.state === 'AWAITING_DESCRIPTION_EDIT_INVOICE' || 
            state.state === 'AWAITING_CATEGORY_EDIT_INVOICE' || state.state === 'AWAITING_PAYMENT_METHOD_EDIT_INVOICE' || 
            state.state === 'AWAITING_DATE_EDIT' || state.state === 'AWAITING_DATE_EDIT_INVOICE' ||
            state.state === 'AWAITING_INVOICE_DATE') {
            
            const isInvoice = state.state.endsWith('_INVOICE') || state.state === 'AWAITING_INVOICE_DATE';
            const dataObj = isInvoice ? state.data.invoiceData : state.data.expenseData;

            if (state.state.startsWith('AWAITING_AMOUNT_EDIT') || state.state === 'AWAITING_INVOICE_DATE') {
                if (state.state.startsWith('AWAITING_AMOUNT_EDIT')) {
                    const amountNum = parseFloat(text.replace(/[^0-9.]/g, ''));
                    if (!isNaN(amountNum)) dataObj.amount = amountNum;
                } else {
                    dataObj.date = text.trim();
                }
            } else if (state.state.startsWith('AWAITING_DATE_EDIT')) {
                dataObj.date = text.trim();
            } else if (state.state.startsWith('AWAITING_DESCRIPTION_EDIT')) {
                dataObj.description = text;
            } else if (state.state.startsWith('AWAITING_CATEGORY_EDIT')) {
                dataObj.category = text;
            } else if (state.state === 'AWAITING_ENTITY_EDIT') {
                dataObj.entity = text;
                return this.handleDocumentRouting(from, dataObj, state.data.receiptPath, 'text');
            } else if (state.state === 'AWAITING_PAYMENT_METHOD_EDIT' || state.state === 'AWAITING_PAYMENT_METHOD_EDIT_INVOICE') {
                dataObj.payment_method = interactiveId || text;
            }

            if (state.state === 'AWAITING_INVOICE_DATE') {
                return this.handleDocumentRouting(from, dataObj, state.data.filePath || state.data.receiptPath, type);
            }

            if (isInvoice) {
                stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', state.data);
                await whatsappService.sendTextMessage(from, t('entry_updated', state.lang));
                await this.sendInvoiceReviewButtons(from, state.data.invoiceData, state.data.filePath);
            } else {
                stateService.setUserState(from, 'AWAITING_EXPENSE_CONFIRMATION', state.data);
                await whatsappService.sendTextMessage(from, t('entry_updated', state.lang));
                await this.sendExpenseReviewButtons(from, state.data.expenseData, state.data.receiptPath);
            }
            return;
        }

        // --- Handle Statement Month Confirmation ---
        if (state.state === 'AWAITING_STATEMENT_CONFIRMATION') {
            if (interactiveId === 'confirm' || textLower === 'confirm') {
                await whatsappService.sendTextMessage(from, t('uploading_stmt', state.lang).replace('${monthYear}', state.data.monthYear));
                const result = await laravelService.uploadStatement(state.data.filePath, from, state.data.monthYear);
                
                if (result.data && (result.data.download_url || result.data.id)) {
                    const downloadUrl = result.data.download_url || `${laravelService.publicUrl}/api/bot/file/${result.data.id}`;
                    
                    if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                    }

                    // 1. Send text confirmation first (standalone)
                    await whatsappService.sendTextMessage(from, t('stmt_uploaded_success', state.lang));
                    
                    // 2. Send the PDF attachment
                    await whatsappService.sendDocument(from, downloadUrl, `Statement_${state.data.monthYear.replace(' ', '_')}.pdf`);
                } else {
                    // Fallback if no URL
                    await whatsappService.sendTextMessage(from, t('stmt_uploaded_success', state.lang));
                }

                // Give Meta/Client time to process PDF before sending Menu to ensure correct order
                await new Promise(resolve => setTimeout(resolve, 1500));

                stateService.clearUserState(from);
                await this.sendWelcomeMenu(from);
            } else if (interactiveId === 'edit_month' || isEdit) {
                stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath: state.data.filePath });
                await whatsappService.sendTextMessage(from, t('prompt_report_period', state.lang));
            } else if (isCancel) {
                stateService.clearUserState(from);
                await whatsappService.sendTextMessage(from, t('cancel_msg', state.lang));
                await this.sendWelcomeMenu(from);
            }
            return;
        }

        // --- Handle Statement Month Selection ---
        if (state.state === 'AWAITING_STATEMENT_MONTH') {
            const monthYear = await aiService.parseStatementMonth(text, from, true);
            
            if (monthYear === 'Unknown') {
                await whatsappService.sendTextMessage(from, t('error_invalid_date', state.lang));
                return;
            }

            return this.handleDocumentRouting(from, { documentType: 'STATEMENT', monthYear }, state.data.filePath, 'text');
        }

        // --- Handle Statement File Upload ---
        if (state.state === 'AWAITING_STATEMENT_FILE' && (type === 'image' || type === 'document')) {
            return;
        }

        // --- Handle Invoice Client Selection ---
        if (state.state === 'AWAITING_INVOICE_CLIENT') {
            if (interactiveId === 'skip_client') {
                stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', state.data);
                await whatsappService.sendTextMessage(from, t('prompt_client_name', state.lang));
                return;
            }
            const clientId = interactiveId || text.split('|')[0].trim();
            const clientName = text.includes('|') ? text.split('|')[1].trim() : text;

            state.data.invoiceData.client_id = clientId;
            state.data.invoiceData.client_name = clientName;

            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        // Redundant AWAITING_INVOICE_DATE handler removed - now handled by central logic above
        
        // --- Handle New Client Name Entry ---
        if (state.state === 'AWAITING_NEW_CLIENT_NAME' && !detectedIntent) {
            if (!interactiveId) { // Only validate if it's raw text
                const isValid = await aiService.validateFieldAI(text, 'ENTITY', from, true);
                if (!isValid) {
                    await whatsappService.sendTextMessage(from, t('error_invalid_client', state.lang));
                    return;
                }
            }
            state.data.invoiceData.client_name = text.trim();
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'text');
        }

        // --- Handle Invoice Payment Method Selection ---
        if (state.state === 'AWAITING_INVOICE_PAYMENT_METHOD' && !detectedIntent) {
            state.data.invoiceData.payment_method = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        if (state.state === 'AWAITING_INVOICE_STATUS' && !detectedIntent) {
            state.data.invoiceData.status = interactiveId ? interactiveId.toUpperCase() : text.toUpperCase();
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        // --- Handle Expense Payment Method Selection ---
        if (state.state === 'AWAITING_EXPENSE_PAYMENT_METHOD' && !detectedIntent) {
            state.data.expenseData.payment_method = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Expense Category Selection ---
        if (state.state === 'AWAITING_EXPENSE_CATEGORY' && !detectedIntent) {
            if (interactiveId === 'skip_category') {
                stateService.setUserState(from, 'AWAITING_CATEGORY_MANUAL', state.data);
                await whatsappService.sendTextMessage(from, t('prompt_edit_category', state.lang));
                return;
            }
            state.data.expenseData.category = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Manual Category Entry ---
        if (state.state === 'AWAITING_CATEGORY_MANUAL' && !detectedIntent) {
            state.data.expenseData.category = text.trim();
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'text');
        }

        // --- Handle Expense Supplier Selection ---
        if (state.state === 'AWAITING_EXPENSE_ENTITY' && !detectedIntent) {
            if (interactiveId === 'skip_supplier') {
                stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', state.data);
                await whatsappService.sendTextMessage(from, t('prompt_supplier_name', state.lang));
                return;
            }
            
            // Validate Name - Bypass AI if it was an interactive selection from our list
            if (!interactiveId) { 
                const isValid = await aiService.validateFieldAI(text, 'ENTITY', from, true);
                if (!isValid) {
                    await whatsappService.sendTextMessage(from, t('error_invalid_entity', state.lang));
                    return;
                }
            }

            state.data.expenseData.entity = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Expense Amount Input ---
        if (state.state === 'AWAITING_EXPENSE_AMOUNT' && !detectedIntent) {
            const parsed = await aiService.parseExpenseText(text, [], from, true);
            const amt = parsed.amount || parseFloat(text.replace(/[^0-9.]/g, ''));
            
            if (!amt || isNaN(amt)) {
                await whatsappService.sendTextMessage(from, t('error_invalid_amount', state.lang));
                return;
            }

            state.data.expenseData.amount = amt;
            if (audioPath) state.data.receiptPath = audioPath; // Link voice note as proof
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, type);
        }

        // 1. Text Unified Parsing
        const initialStates = ['IDLE', 'AWAITING_EXPENSE_DATA', 'AWAITING_INVOICE_DATA', 'AWAITING_STATEMENT_DATA'];
        const isCapturing = state.state && state.state !== 'IDLE';

        const isCommand = (initialStates.includes(state.state) || (!state.state || state.state === 'IDLE')) && 
                          (textLower.startsWith('expense') || 
                           textLower.startsWith('invoice') || 
                           textLower.startsWith('statement') || 
                           text.split(' ').length > 2 ||
                           isCapturing); // If already in a flow, treat any input as a command for the parser

        if ((type === 'text' || type === 'audio' || type === 'voice') && isCommand) {
            try {
                const categories = await laravelService.getCategories(from);
                // Pass 'true' to skipCooldown because we already checked quota in the intent sensing above
                const data = await aiService.parseExpenseText(text, categories, from, true);
                await this.handleDocumentRouting(from, data, null, type);
            } catch (error) {
                if (error.message.includes("quota") || error.message.includes("limit")) {
                    await whatsappService.sendTextMessage(from, `🛑 *AI Limit Reached*\n\n${error.message}`);
                } else {
                    throw error;
                }
            }
            return;
        }
      }

      // 2. Media Handler (Image, Document)
      if (type === 'image' || type === 'document') {
            const state = await stateService.getUserState(from);
            const isCapturing = state.state !== 'IDLE';

            // --- SMART AI TRIGGER ---
            const initialStates = ['AWAITING_EXPENSE_DATA', 'AWAITING_INVOICE_DATA', 'AWAITING_STATEMENT_DATA'];
            const needsAI = !isCapturing || 
                            initialStates.includes(state.state) || 
                            state.state.includes('EDIT') || 
                            state.state.includes('ENTITY') || 
                            state.state.includes('CATEGORY') ||
                            state.state.includes('AMOUNT') ||
                            state.state.includes('DATE');
            if (!isCapturing) {
                await whatsappService.sendTextMessage(from, t('analyzing_media', state.lang, { type }));
            } else if (needsAI) {
                await whatsappService.sendTextMessage(from, t('processing_media', state.lang, { type }));
            } else {
                await whatsappService.sendTextMessage(from, t('linking_media', state.lang, { type }));
            }
            
            const mediaId = message[type].id;
            const extension = type === 'image' ? 'jpg' : (message.document.filename?.split('.').pop() || 'pdf');
            const localPath = await storageService.downloadMedia(mediaId, `${type}_${Date.now()}.${extension}`);
            
            const stats = fs.statSync(localPath);
            const fileSizeInMegabytes = stats.size / (1024 * 1024);
            if (fileSizeInMegabytes > 2.0) {
                await whatsappService.sendTextMessage(from, t('file_too_large', state.lang));
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                return;
            }

            let data = {};
            const categories = await laravelService.getCategories(from);

            if (needsAI) {
                try {
                    if (type === 'image') {
                        // PIVOT: Following 10-step requirement (Step 7)
                        // File First (IDLE) = Bank Statement.
                        if (!isCapturing) {
                            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath: localPath });
                            await whatsappService.sendTextMessage(from, t('stmt_detected_image', state.lang));
                            return;
                        } else {
                            // Already in a recording flow - just link as proof
                            const dataKey = state.state.includes('INVOICE') ? 'filePath' : 'receiptPath';
                            const stateData = state.data || {};
                            stateData[dataKey] = localPath;
                            stateService.setUserState(from, state.state, stateData);
                            
                            // Continue logic for current data without redundant message
                            data = state.state.includes('INVOICE') ? stateData.invoiceData : stateData.expenseData;
                        }
                    } else {
                        // PDF / Document Handler
                        let documentType = extension === 'pdf' ? 'STATEMENT' : 'EXPENSE';
                        if (state.state.includes('INVOICE')) documentType = 'INVOICE';
                        data = { documentType, description: `Document: ${message.document?.filename || 'PDF'}` };
                    }
                } catch (error) {
                    if (error.message.includes("quota")) {
                        await whatsappService.sendTextMessage(from, `🛑 *AI Limit Reached*`);
                        return;
                    }
                    throw error;
                }
            } else {
                if (state.state.includes('EXPENSE')) data.documentType = 'EXPENSE';
                else if (state.state.includes('INVOICE')) data.documentType = 'INVOICE';
                else if (state.state.includes('STATEMENT')) data.documentType = 'STATEMENT';
                data.description = `Linked ${type.toUpperCase()} Attachment`;
            }

            await this.handleDocumentRouting(from, data, localPath, type);
            return;
      }

      // Fallback: If nothing matched, handle based on current state
      if (type !== 'status' && !interactiveId) {
        if (state.state && state.state !== 'IDLE') {
            const flowName = state.state.includes('INVOICE') ? t('label_client', state.lang).toLowerCase() : (state.state.includes('STATEMENT') ? t('btn_upload_stmt', state.lang).toLowerCase() : t('btn_record_expense', state.lang).toLowerCase());
            await whatsappService.sendTextMessage(from, t('unrecognized_flow', state.lang, { flow: flowName }));
        } else {
            await this.sendWelcomeMenu(from);
        }
      }
    } catch (error) {
      console.error('❌ ERROR IN PROCESS MESSAGE:', error);
    }
  }

  /**
   * Centralizes routing for all document types (text or media)
   */
  async handleDocumentRouting(from, data, filePath, type) {
    const currentState = await stateService.getUserState(from);
    logger.debug(`[DEBUG] ROUTING START - State: ${currentState?.state}`);
    const existingData = (currentState && currentState.data) ? (currentState.data.expenseData || currentState.data.invoiceData || {}) : {};
    logger.debug(`[DEBUG] Existing Data:`, existingData);
    const today = new Date().toISOString().split('T')[0];
    const invalidVals = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined', ''];
    
    // --- MEMOIZATION HELPERS: Ensure we only fetch these lists once per request ---
    let cachedSuppliers = null;
    let cachedClients = null;

    const fetchSuppliers = async () => {
      if (!cachedSuppliers) cachedSuppliers = await laravelService.getSuppliers(from);
      return cachedSuppliers;
    };

    const fetchClients = async () => {
      if (!cachedClients) cachedClients = await laravelService.getClients(from);
      return cachedClients;
    };

    let mergedData = { 
        payment_method: 'WhatsApp',
        ...data 
    };

    // --- 1. NORMALIZATION (AI -> Internal Fields) ---
    // Move AI 'entity' to 'client_name' or 'supplier_name' before merging
    if (mergedData.documentType === 'INVOICE' && mergedData.entity && !invalidVals.includes(mergedData.entity.toLowerCase())) {
        mergedData.client_name = mergedData.entity;
    }
    
    // Normalize Status immediately
    if (mergedData.status) {
        if (mergedData.status.toLowerCase() === 'paid') mergedData.status = 'Paid';
        if (mergedData.status.toLowerCase() === 'unpaid') mergedData.status = 'Unpaid';
    }

    // --- 2. SMART MERGE (Priority: New > Old) ---
    const isCapturing = currentState && currentState.state !== 'IDLE';
    if (isCapturing) {

        const invalidVals = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined', ''];
        
        // Amount priority: New > Old
        if (!mergedData.amount && existingData.amount) mergedData.amount = existingData.amount;
        
        // Category priority: New (if valid) > Old
        if ((!mergedData.category || invalidVals.includes(mergedData.category.toLowerCase())) && existingData.category) {
            mergedData.category = existingData.category;
        }
        
        // Entity priority: New (if valid) > Old
        if ((!mergedData.entity || invalidVals.includes(mergedData.entity.toLowerCase())) && existingData.entity) {
            mergedData.entity = existingData.entity;
        }
        
        // Status priority: New (if valid) > Old
        const currentStatus = mergedData.status?.toLowerCase();
        if ((!mergedData.status || invalidVals.includes(currentStatus)) && existingData.status) {
            mergedData.status = existingData.status;
        }

        // --- SMART DATE PRESERVATION ---
        // If we have an existing date (like 'Yesterday') and the new one is null or Today (default AI guess), keep the old one.
        if (existingData.date && (!mergedData.date || mergedData.date === today)) {
            mergedData.date = existingData.date;
        }

        if ((!mergedData.notes || mergedData.notes === '') && existingData.notes) mergedData.notes = existingData.notes;
        if ((!mergedData.description || mergedData.description === '') && existingData.description) mergedData.description = existingData.description;

        // Client Name priority: New (if valid) > Old
        const newClientName = mergedData.client_name || mergedData.entity;
        const isClientValid = newClientName && !invalidVals.includes(newClientName.toLowerCase());
        
        if (isClientValid) {
            // ONLY clear the context ID if the NEW name is actually a match for a DIFFERENT known client
            // This prevents "Utilities" or other noise from clearing your selected context
            if (existingData.client_id && existingData.client_name && existingData.client_name.toLowerCase() !== newClientName.toLowerCase()) {
                const clients = await fetchClients();
                const searchName = newClientName.toLowerCase().replace(/[.!]$/, '').trim();
                const isAnotherKnownClient = clients.some(c => 
                    (c.company_name && c.company_name.toLowerCase().replace(/[.!]$/, '').trim() === searchName) ||
                    (c.client_name && c.client_name.toLowerCase().replace(/[.!]$/, '').trim() === searchName)
                );
                
                if (isAnotherKnownClient) {
                    mergedData.client_id = null;
                    mergedData.client_name = newClientName;
                } else {
                    // It's probably noise, stick to the context
                    mergedData.client_id = existingData.client_id;
                    mergedData.client_name = existingData.client_name;
                    mergedData.entity = existingData.client_name; // Sync entity field too
                }
            } else {
                mergedData.client_name = newClientName;
            }
        } else if (existingData.client_name) {
            mergedData.client_name = existingData.client_name;
        }

        if ((!mergedData.description || mergedData.description.includes('Attachment') || mergedData.description.includes('Document') || mergedData.description.includes('Pending')) && (existingData.description || existingData.notes)) {
            mergedData.description = existingData.description || existingData.notes;
        }
        
        // Preserve Category if already set
        if (existingData.category && !mergedData.category) {
            mergedData.category = existingData.category;
        } else if (existingData.category && mergedData.category && mergedData.category !== existingData.category) {
            // Keep the one already in session if it's not a generic guess
            mergedData.category = existingData.category;
        }

        // --- SMART CURRENCY PRESERVATION ---
        // If the user manually provided a currency in the initial message/flow, we STICK to it.
        // AI Vision guesses from images often flip to USD/EUR incorrectly. Use the session data as the source of truth.
        if (existingData.currency && mergedData.currency !== existingData.currency) {
            mergedData.currency = existingData.currency;
        }

        // --- SMART PAYMENT PRESERVATION ---
        const invalidPay = ['whatsapp', 'other', 'unknown', 'none', null];
        if (existingData.payment_method && !invalidPay.includes(existingData.payment_method.toLowerCase()) && invalidPay.includes(mergedData.payment_method?.toLowerCase())) {
            mergedData.payment_method = existingData.payment_method;
        } else if (existingData.payment_method && !mergedData.payment_method) {
            mergedData.payment_method = existingData.payment_method;
        }
        
        // STRICTLY preserve original type and data during an active session
        if (currentState.state.includes('EXPENSE')) {
            mergedData.documentType = 'EXPENSE';

            const newEntityName = mergedData.entity;
            const isEntityValid = newEntityName && !invalidVals.includes(newEntityName.toLowerCase());

            if (isEntityValid && existingData.supplier_id && existingData.entity && existingData.entity.toLowerCase() !== newEntityName.toLowerCase()) {
                // Check if the NEW name is actually another known supplier
                const suppliers = await fetchSuppliers();
                const searchName = newEntityName.toLowerCase().replace(/[.!]$/, '').trim();
                const isAnotherKnownSupplier = suppliers.some(s => s.name && s.name.toLowerCase().replace(/[.!]$/, '').trim() === searchName);
                
                if (isAnotherKnownSupplier) {
                    mergedData.supplier_id = null;
                } else {
                    mergedData.supplier_id = existingData.supplier_id;
                    mergedData.entity = existingData.entity;
                }
            } else if (existingData.supplier_id && (!mergedData.entity || invalidVals.includes(mergedData.entity.toLowerCase()))) {
                mergedData.supplier_id = existingData.supplier_id;
                mergedData.entity = existingData.entity;
            }
        } else if (currentState.state.includes('INVOICE')) {
            mergedData.documentType = 'INVOICE';
            if (existingData.client_id && (!mergedData.client_name || invalidVals.includes(mergedData.client_name.toLowerCase()))) {
                mergedData.client_id = existingData.client_id;
            }
        } else if (currentState.state.includes('STATEMENT')) {
            mergedData.documentType = 'STATEMENT';
            if (currentState.data.monthYear) mergedData.monthYear = currentState.data.monthYear;
        }
    }

    // --- 3. RE-REFINED SEQUENCING: Map and Resolve AFTER Merge ---
    
    // Final check for entity mapping
    if (mergedData.documentType === 'INVOICE' && mergedData.entity && mergedData.entity !== 'General' && (!mergedData.client_name || mergedData.client_name === 'General')) {
        mergedData.client_name = mergedData.entity;
    }

    // --- Status Normalization & Protection ---
    if (mergedData.status) {
        const s = mergedData.status.toLowerCase();
        if (s.includes('paid') && !s.includes('unpaid') && !s.includes('partially')) mergedData.status = 'Paid';
        else if (s.includes('unpaid')) mergedData.status = 'Unpaid';
        else if (s.includes('partially')) mergedData.status = 'Partially Paid';
    }

    // --- Automated Name Resolution (Punctuation Agnostic) ---
    const sanitize = (val) => val ? val.toLowerCase().replace(/[.!]$/, '').trim() : '';
    
    if (mergedData.client_name && !mergedData.client_id && mergedData.documentType === 'INVOICE') {
        const clients = await fetchClients();
        const searchName = sanitize(mergedData.client_name);
        
        const match = clients.find(c => 
            sanitize(c.company_name) === searchName ||
            sanitize(c.client_name) === searchName
        );
        if (match) {
            mergedData.client_id = match.id;
            mergedData.client_name = match.company_name || match.client_name;
        }
    } else if (mergedData.entity && mergedData.entity !== 'General' && !mergedData.supplier_id && mergedData.documentType === 'EXPENSE') {
        const suppliers = await fetchSuppliers();
        const searchName = sanitize(mergedData.entity);
        
        const match = suppliers.find(s => sanitize(s.name) === searchName);
        if (match) {
            mergedData.supplier_id = match.id;
            mergedData.entity = match.name;
        }
    }

    if (mergedData.documentType === 'STATEMENT') {
        const monthYear = mergedData.monthYear || (isCapturing && currentState.data?.monthYear);

        if (monthYear && filePath && type !== 'audio') {
            stateService.setUserState(from, 'AWAITING_STATEMENT_CONFIRMATION', { filePath, monthYear });
            await this.sendStatementReviewButtons(from, monthYear);
        } else if (monthYear) {
            stateService.setUserState(from, 'AWAITING_STATEMENT_FILE', { monthYear });
            await whatsappService.sendTextMessage(from, t('stmt_got_it', state.lang, { monthYear }));
        } else {
            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath });
            await whatsappService.sendTextMessage(from, t('stmt_detected_pdf', state.lang));
        }
    } else if (mergedData.documentType === 'INVOICE') {
        const inv = mergedData;
        const invalidValues = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined'];
        
        // --- VALIDATION GUARD: Ensure we have at least an amount or a visual file ---
        // If it's a voice note (audio), we REQUIRE an amount to be extracted before proceeding.
        const isAudio = filePath && filePath.endsWith('.ogg');
        if (!inv.amount && (!filePath || isAudio)) {
            const source = isAudio ? t('voice_note', state.lang).toLowerCase() : t('btn_menu', state.lang).toLowerCase(); // Fallback label
            await whatsappService.sendTextMessage(from, t('error_no_amount_found', state.lang, { source }));
            return;
        }

        // --- DATA HARDENING: Pull from session if AI missed it in this specific turn ---
        if (!inv.status && existingData.status) inv.status = existingData.status;
        if (!inv.client_id && existingData.client_id) inv.client_id = existingData.client_id;
        if ((!inv.client_name || invalidValues.includes(inv.client_name.toLowerCase())) && existingData.client_name) inv.client_name = existingData.client_name;
        if ((!inv.payment_method || inv.payment_method === 'WhatsApp') && existingData.payment_method && existingData.payment_method !== 'WhatsApp') inv.payment_method = existingData.payment_method;

        // 1. Date Check
        if (!inv.date) {
            stateService.setUserState(from, 'AWAITING_INVOICE_DATE', { filePath, invoiceData: inv });
            await whatsappService.sendTextMessage(from, t('prompt_invoice_date', state.lang));
            return;
        } 
        
        // 2. Client Check
        const isNameInvalid = !inv.client_name || invalidValues.includes(inv.client_name.toLowerCase());
        if (!inv.client_id && isNameInvalid) {
            const clients = await fetchClients();
            if (clients && clients.length > 0) {
                stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', { filePath, invoiceData: inv });
                await this.sendClientSelectionList(from, clients);
            } else {
                stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', { filePath, invoiceData: inv });
                await whatsappService.sendTextMessage(from, t('prompt_ai_no_client', state.lang));
            }
            return;
        }

        // 3. Payment Method Check
        if (!inv.payment_method || invalidValues.includes(inv.payment_method.toLowerCase()) || inv.payment_method.toLowerCase() === 'whatsapp') {
            stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', { filePath, invoiceData: inv });
            await this.sendPaymentMethodSelectionList(from, 'INVOICE');
            return;
        }

        // 4. Status Check (Robust)
        const hasStatus = inv.status && !invalidValues.includes(inv.status.toLowerCase());
        if (!hasStatus) {
            stateService.setUserState(from, 'AWAITING_INVOICE_STATUS', { filePath, invoiceData: inv });
            await this.sendInvoiceStatusButtons(from);
            return;
        }

        // 5. All Clear! Show Review
        stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', { filePath, invoiceData: inv });
        await this.sendInvoiceReviewButtons(from, inv, filePath);
    } else {
        // Default: EXPENSE
        if (mergedData.amount || filePath) {
            const today = new Date().toISOString().split('T')[0];
            if (!mergedData.date) mergedData.date = today;

            // Strict Flow: Check for missing or placeholder fields before confirmation
            const invalidValues = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined'];

            if (!mergedData.amount || parseFloat(mergedData.amount) <= 0) {
                stateService.setUserState(from, 'AWAITING_EXPENSE_AMOUNT', { expenseData: mergedData, receiptPath: filePath });
                await whatsappService.sendTextMessage(from, t('error_invalid_amount', state.lang));
                return;
            }

            if (!mergedData.category || invalidValues.includes(mergedData.category.toLowerCase())) {
                const categories = await laravelService.getCategories(from);
                stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', { expenseData: mergedData, receiptPath: filePath });
                await this.sendCategorySelectionList(from, categories);
            } else if (!mergedData.supplier_id && (!mergedData.entity || invalidValues.includes(mergedData.entity.toLowerCase()))) {
                const suppliers = await fetchSuppliers();
                if (suppliers && suppliers.length > 0) {
                    stateService.setUserState(from, 'AWAITING_EXPENSE_ENTITY', { expenseData: mergedData, receiptPath: filePath });
                    await this.sendSupplierSelectionList(from, suppliers);
                } else {
                    // No suppliers found, ask to type it or skip
                    stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', { expenseData: mergedData, receiptPath: filePath });
                    await whatsappService.sendTextMessage(from, t('prompt_ai_no_supplier', state.lang));
                }
            } else if (!mergedData.payment_method || invalidValues.includes(mergedData.payment_method.toLowerCase()) || mergedData.payment_method.toLowerCase() === 'whatsapp') {
                stateService.setUserState(from, 'AWAITING_EXPENSE_PAYMENT_METHOD', { expenseData: mergedData, receiptPath: filePath });
                await this.sendPaymentMethodSelectionList(from, 'EXPENSE');
            } else {
                // All fields present!
                stateService.setUserState(from, 'AWAITING_EXPENSE_CONFIRMATION', { expenseData: mergedData, receiptPath: filePath });
                await this.sendExpenseReviewButtons(from, mergedData, filePath);
            }
        } else if (type !== 'status') {
            // Re-prompt instead of Menu if we are in a dedicated flow
            const isCapturing = currentState && currentState.state !== 'IDLE';
            if (isCapturing) {
                const flowName = currentState.state.includes('INVOICE') ? 'invoice' : 'expense';
                await whatsappService.sendTextMessage(from, `🤔 I'm sorry, I couldn't find an amount or valid details in that ${type}. \n\nPlease try again or provide a document for this ${flowName}.`);
            } else {
                await this.sendWelcomeMenu(from);
            }
        }
    }
  }

  async sendTemplate(req, res) {
    const { to, template, language, components } = req.body;
    try {
      const data = await whatsappService.sendTemplate(to, template, language, components);
      res.status(200).json({ success: true, metaResponse: data });
    } catch (error) {
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  }

  async sendHelloWorld(req, res) {
      const { to } = req.body;
      if (!to) return res.status(400).json({ error: 'Recipient number required' });
      try {
          const data = await whatsappService.sendSimpleTemplate(to);
          res.status(200).json({ success: true, metaResponse: data });
      } catch (error) {
          res.status(500).json({ error: 'Failed' });
      }
  }

  // --- INTERACTIVE UI HELPERS ---

  async sendReportMenu(from) {
      const state = await stateService.getUserState(from);
      const [clients, suppliers] = await Promise.all([
          laravelService.getClients(from),
          laravelService.getSuppliers(from)
      ]);
      const body = t('report_select_title', state.lang);
      const rowsGeneral = [
          { id: 'rep_gen_unpaid', title: t('btn_unpaid_invoices', state.lang) },
          { id: 'rep_gen_month', title: t('btn_monthly_summary', state.lang) },
          { id: 'rep_gen_search', title: t('btn_search_name', state.lang) }
      ];
      const rowsClients = (clients || []).slice(0, 3).map(c => ({
          id: `rep_c_${c.id}`,
          title: (c.company_name || c.client_name).substring(0, 24)
      }));
      const rowsSuppliers = (suppliers || []).slice(0, 3).map(s => ({
          id: `rep_s_${s.id}`,
          title: s.name.substring(0, 24)
      }));
      
      const sections = [{ title: t('section_general_reports', state.lang), rows: rowsGeneral }];
      if (rowsClients.length > 0) sections.push({ title: t('section_recent_clients', state.lang), rows: rowsClients });
      if (rowsSuppliers.length > 0) sections.push({ title: t('section_recent_suppliers', state.lang), rows: rowsSuppliers });
      
      return whatsappService.sendInteractiveList(from, body, t('list_trigger_options', state.lang), sections);
  }

  async handleReportMenuSelection(from, interactiveId) {
      const state = await stateService.getUserState(from);
      if (interactiveId === 'rep_gen_month') {
          await whatsappService.sendTextMessage(from, t('fetching_status', state.lang));
          const stats = await laravelService.getAccountStatus(from);
          await this.sendStatusInteractive(from, stats);
      } else if (interactiveId === 'rep_gen_unpaid') {
          const stats = await laravelService.getAccountStatus(from);
          if (stats.total_unpaid_sum > 0) {
              await whatsappService.sendTextMessage(from, t('alert_unpaid_total', state.lang, { total: stats.total_unpaid_sum, count: stats.invoicesCount }));
          } else if (stats.invoicesCount > 0) {
              await whatsappService.sendTextMessage(from, t('alert_no_unpaid', state.lang, { count: stats.invoicesCount }));
          } else {
              await whatsappService.sendTextMessage(from, t('alert_no_invoices', state.lang));
          }
      } else if (interactiveId === 'rep_gen_search') {
          stateService.setUserState(from, 'AWAITING_REPORT_SEARCH');
          await whatsappService.sendTextMessage(from, t('prompt_search_name', state.lang));
      } else if (interactiveId.startsWith('rep_c_') || interactiveId.startsWith('rep_s_')) {
          const parts = interactiveId.split('_');
          const isClient = parts[1] === 'c';
          const entityId = parts[2];
          
          // Fetch the full entity details so we don't 'lose track' in the next step
          const entities = isClient ? await laravelService.getClients(from) : await laravelService.getSuppliers(from);
          const entity = entities ? entities.find(e => e.id == entityId) : null;
          
          if (entity) {
              stateService.setUserState(from, 'AWAITING_REPORT_PERIOD', { entityId, isClient, entity });
              await this.sendReportPeriodButtons(from);
          } else {
              await whatsappService.sendTextMessage(from, "❌ Sorry, I couldn't find that record. Please try searching for them again.");
              stateService.clearUserState(from);
          }
      }
  }

  async sendReportPeriodButtons(from) {
      const state = await stateService.getUserState(from);
      const sections = [
        {
          title: t('section_standard_periods', state.lang),
          rows: [
            { id: 'rep_period_this', title: t('this_month', state.lang) },
            { id: 'rep_period_last', title: t('last_month_name', state.lang) },
            { id: 'rep_period_all', title: t('all_time', state.lang) }
          ]
        },
        {
          title: t('section_custom_search', state.lang),
          rows: [
            { id: 'rep_period_custom', title: t('btn_custom_month', state.lang), description: t('desc_custom_month', state.lang) }
          ]
        }
      ];
      await whatsappService.sendInteractiveList(from, `${t('report_period_title', state.lang)}\n\n${t('report_period_body', state.lang)}`, t('list_trigger_period', state.lang), sections);
  }

  async sendWelcomeMenu(from) {
    const state = await stateService.getUserState(from);
    const body = t('welcome', state.lang);
    
    const sections = [
      {
        title: t('btn_menu', state.lang),
        rows: [
          { 
            id: 'status', 
            title: t('btn_status', state.lang), 
            description: t('desc_status', state.lang) 
          },
          { 
            id: 'record', 
            title: t('btn_record_expense', state.lang), 
            description: t('desc_record_expense', state.lang) 
          },
          { 
            id: 'inv', 
            title: t('btn_record_invoice', state.lang), 
            description: t('desc_record_invoice', state.lang) 
          },
          { 
            id: 'quick_reports', 
            title: t('btn_reports', state.lang), 
            description: t('desc_reports', state.lang) 
          },
          { 
            id: 'stmt', 
            title: t('btn_upload_stmt', state.lang), 
            description: t('desc_upload_stmt', state.lang) 
          }
        ]
      }
    ];

    return whatsappService.sendInteractiveList(
        from, 
        body, 
        t('menu_trigger', state.lang), 
        sections
    );
  }

  async sendStatusInteractive(from, stats) {
    const state = await stateService.getUserState(from);
    const { targetMonth, targetYear } = stats;

    // 1. Parallel fetch details (Invoices, Expenses, Statements) - Synchronized with target period
    const [invoices, expenses, statements] = await Promise.all([
      laravelService.getInvoices(from, 'ISSUED', targetMonth, targetYear),
      laravelService.getExpenses(from, targetMonth, targetYear),
      laravelService.getBankStatements(from, targetMonth, targetYear)
    ]);

    const income = stats.salesSum || 0;
    const expensesTotal = stats.expensesSum || 0;
    const balance = income - expensesTotal;
    const vat = stats.vatPayable || 0;
    
    // Localized Currency Formatter
    const currency = stats.currency || 'MAD';
    const fmt = (num) => {
        const val = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { 
            minimumFractionDigits: 2, 
            maximumFractionDigits: 2 
        }).format(num);
        return `${val} ${currency}`;
    };

    // Granular Status Logic (Restored from previous English version but localized)
    let statusIcon = '⚪';
    let statusText = t('status_no_activity', state.lang);
    
    if (stats.invoicesCount > 0) {
        if (stats.pendingReviewCount > 0) {
            statusIcon = '🟡';
            statusText = t('status_pending_review', state.lang);
        } else if (stats.statementsCount > 0) {
            statusIcon = '🟢';
            statusText = t('status_validated', state.lang);
        } else {
            statusIcon = '🟠';
            statusText = t('status_missing_docs', state.lang);
        }
    } else if (stats.statementsCount > 0) {
        statusIcon = '🟠';
        statusText = t('status_invoices_missing', state.lang);
    }

    const missing = [];
    if (!stats.statementsCount) missing.push(t('btn_upload_stmt', state.lang).replace('📄', '').trim());
    if (stats.invoicesCount === 0) missing.push(t('btn_record_invoice', state.lang));

    // --- DETAILED SECTIONS ---
    let detailText = '';

    // Unpaid Invoices List
    if (invoices.length > 0) {
        detailText += `📑 *${t('unpaid_invoices', state.lang)} (Top 3):*\n`;
        invoices.slice(0, 3).forEach(inv => {
            const client = inv.client?.client_name || 'Client';
            const amount = (inv.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
            detailText += `• ${client}: ${fmt(amount)}\n`;
        });
        detailText += `\n`;
    }

    // Recent Expenses List
    if (expenses.length > 0) {
        detailText += `🏷️ *${t('recent_expenses', state.lang)} (Top 3):*\n`;
        expenses.slice(0, 3).forEach(exp => {
            const category = exp.category?.name || 'General';
            const amount = parseFloat(exp.total_ttc || 0);
            detailText += `• ${category}: ${fmt(amount)}\n`;
        });
        detailText += `\n`;
    }

    // Statement History Hint
    if (statements.length > 0) {
        const last = statements[0];
        detailText += `📅 *${t('last_statement', state.lang)}:* ${last.month_year} (${last.status || t('processed', state.lang)})\n\n`;
    }

    const missingText = missing.length > 0 
        ? `${t('report_missing', state.lang)} ${missing.join(', ')}\n_(${t('upload_portal_msg', state.lang)})_` 
        : t('report_ready', state.lang);

    let body = `${t('report_title', state.lang)}: ${stats.month}\n` +
               `━━━━━━━━━━━━━━━━━━\n\n` +
               `${t('report_performance', state.lang)}\n` +
               `* ${t('report_income', state.lang)}:   ${fmt(income)}\n` +
               `* ${t('report_expenses', state.lang)}: ${fmt(expensesTotal)}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🏦 *${t('report_balance', state.lang)}:  ${fmt(balance)}*\n\n` +
               `${t('report_tax', state.lang)}\n` +
               `* ${t('report_vat', state.lang)}:    ${fmt(vat)}\n\n` +
               `${t('report_progress', state.lang)}\n` +
               `* ${t('report_status', state.lang)}: ${statusIcon} ${statusText}\n\n` +
               detailText +
               `${missingText}\n\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `${t('select_action', state.lang)}`;
               
    const buttons = [
      { id: 'record', title: t('btn_record_expense', state.lang) },
      { id: 'inv', title: t('btn_record_invoice', state.lang) },
      { id: 'menu', title: t('btn_menu', state.lang) }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendExpenseReviewButtons(from, expenseData, receiptPath = null) {
    const state = await stateService.getUserState(from);
    const path = require('path');
    let notes = expenseData.description || t('business_expense', state.lang);

    // Localize Payment Method Display
    const rawPayment = expenseData.payment_method || 'WhatsApp';
    const payKey = `pay_${rawPayment.replace(/[\s\/]/g, '_')}`;
    const localizedPayment = t(payKey, state.lang);

    let body = `*${t('review_expense', state.lang)}*\n` +
      `*${t('field_amount', state.lang)}:* ${expenseData.amount} ${expenseData.currency || 'MAD'}\n` +
      `*${t('field_date', state.lang)}:* ${expenseData.date || '---'}\n` +
      `*${t('field_entity_supplier', state.lang)}:* ${expenseData.entity || '...'}\n` +
      `*${t('field_category', state.lang)}:* ${expenseData.category || '...'}\n` +
      `*${t('field_payment', state.lang)}:* ${localizedPayment}\n` +
      `*${t('field_notes', state.lang)}:* ${notes}\n\n`;

    if (receiptPath) {
      const fileName = path.basename(receiptPath);
      if (!fileName.endsWith('.ogg')) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `📄 *${t('image_attached', state.lang)}:*\n${previewUrl}`;
      } else {
        body += `🎙️ *${t('voice_note', state.lang)}:* ${t('processed', state.lang)}`;
      }
    } else {
      body += `\n${t('prompt_upload_media_optional', state.lang)}\n`;
    }
    
    const buttons = [
      { id: 'confirm', title: t('btn_confirm', state.lang) },
      { id: 'edit', title: t('btn_edit', state.lang) },
      { id: 'cancel', title: t('btn_cancel', state.lang) }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendInvoiceReviewButtons(from, invoiceData, filePath = null) {
    const state = await stateService.getUserState(from);
    const path = require('path');
    let notes = invoiceData.description || t('services_rendered', state.lang);

    // Localize Payment Method Display
    const rawPayment = invoiceData.payment_method || 'WhatsApp';
    const payKey = `pay_${rawPayment.replace(/[\s\/]/g, '_')}`;
    const localizedPayment = t(payKey, state.lang);

    let body = `*${t('review_invoice', state.lang)}*\n` +
      `*${t('field_amount', state.lang)}:* ${invoiceData.amount} ${invoiceData.currency || 'MAD'}\n` +
      `*${t('field_date', state.lang)}:* ${invoiceData.date || '---'}\n` +
      `*${t('field_entity_client', state.lang)}:* ${invoiceData.entity || '...'}\n` +
      `*${t('field_payment', state.lang)}:* ${localizedPayment}\n` +
      `*${t('field_status', state.lang)}:* ${invoiceData.status || '...'}\n` +
      `*${t('field_notes', state.lang)}:* ${notes}\n\n`;

    if (filePath) {
      const fileName = path.basename(filePath);
      if (!fileName.endsWith('.ogg')) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `📄 *${t('document_attached', state.lang)}:*\n${previewUrl}`;
      } else {
        body += `🎙️ *${t('voice_note', state.lang)}:* ${t('processed', state.lang)}`;
      }
    } else {
      body += `\n${t('prompt_upload_media_optional', state.lang)}\n`;
    }
    
    const buttons = [
      { id: 'confirm', title: t('btn_confirm', state.lang) },
      { id: 'edit', title: t('btn_edit', state.lang) },
      { id: 'cancel', title: t('btn_cancel', state.lang) }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendStatementReviewButtons(from, monthYear) {
    const state = await stateService.getUserState(from);
    const body = `${t('stmt_review_title', state.lang)}\n\n` +
                 `${t('stmt_review_month', state.lang)}: *${monthYear}*\n\n` +
                 `${t('stmt_review_prompt', state.lang)}`;

    const buttons = [
      { id: 'confirm', title: t('btn_confirm', state.lang) },
      { id: 'edit_month', title: t('btn_edit', state.lang) },
      { id: 'cancel', title: t('btn_cancel', state.lang) }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendEditSelectionButtons(from, type = 'EXPENSE') {
    const state = await stateService.getUserState(from);
    const isInvoice = type === 'INVOICE';
    const body = t('edit_selection_prompt', state.lang);
    let rows = [
      { id: 'amt', title: t('field_amount', state.lang) },
      { id: 'date', title: t('field_date', state.lang) },
      { id: 'ent', title: isInvoice ? t('field_entity_client', state.lang) : t('field_entity_supplier', state.lang) },
      { id: 'pay', title: t('field_payment', state.lang) }
    ];

    if (!isInvoice) {
      rows.splice(3, 0, { id: 'cat', title: t('field_category', state.lang) });
    }

    rows.push({ id: 'desc', title: isInvoice ? t('field_notes', state.lang) : t('field_description', state.lang) });
    rows.push({ id: 'all', title: t('btn_resubmit', state.lang) });
    
    const sections = [{ title: t('section_modification', state.lang), rows }];
    return whatsappService.sendInteractiveList(from, body, t('list_trigger_options', state.lang), sections);
  }

  async sendPaymentMethodSelectionList(from, type = 'INVOICE') {
    const state = await stateService.getUserState(from);
    const body = t('payment_method_prompt', state.lang);
    
    const enMethods = ["Cash", "Bank Transfer", "Credit/Debit Card", "Cheque", "Mobile Payment", "Online Payment", "Direct Debit", "Instant Bank Transfer", "PayPal", "Other"];
    const frMethods = ["Espèces", "Virement Bancaire", "Carte Bancaire", "Chèque", "Paiement Mobile", "Paiement en Ligne", "Prélèvement", "Virement Instantané", "PayPal", "Autre"];
    const methods = state.lang === 'fr' ? frMethods : enMethods; // Logic choice, not string literal

    const rows = methods.map((m, i) => ({
      id: enMethods[i], // Keep English ID for backend compatibility
      title: m
    }));
    
    const sections = [{ title: t('section_payment_methods', state.lang), rows }];
    return whatsappService.sendInteractiveList(from, body, t('list_trigger_payment', state.lang), sections);
  }

  async sendClientSelectionList(from, clients) {
    const state = await stateService.getUserState(from);
    const body = t('client_selection_prompt', state.lang);
    const rows = clients.slice(0, 9).map(client => ({
        id: `${client.id}`,
        title: (client.company_name || client.client_name).substring(0, 24),
        description: `${t('field_customer_id', state.lang)}: ${client.id}`
    }));

    rows.push({ id: 'skip_client', title: t('btn_new_client', state.lang), description: t('desc_new_client', state.lang) });

    const sections = [{ title: t('section_clients', state.lang), rows }];
    return whatsappService.sendInteractiveList(from, body, t('list_trigger_clients', state.lang), sections);
  }

  async sendCategorySelectionList(from, categories) {
    const state = await stateService.getUserState(from);
    const body = t('category_selection_prompt', state.lang);
    const rows = categories.slice(0, 9).map(cat => ({
        id: (cat.name || cat).substring(0, 200),
        title: (cat.name || cat).substring(0, 24)
    }));

    rows.push({ id: 'skip_category', title: t('btn_new_category', state.lang), description: t('desc_new_category', state.lang) });

    const sections = [{ title: t('section_categories', state.lang), rows }];
    return whatsappService.sendInteractiveList(from, body, t('list_trigger_categories', state.lang), sections);
  }

  async sendSupplierSelectionList(from, suppliers) {
    const state = await stateService.getUserState(from);
    const body = t('supplier_selection_prompt', state.lang);
    const rows = suppliers.slice(0, 9).map(s => ({
        id: s.name,
        title: s.name.substring(0, 24),
        description: `ID: ${s.id}`
    }));
    
    rows.push({ id: 'skip_supplier', title: t('btn_new_supplier', state.lang), description: t('desc_new_supplier', state.lang) });

    const sections = [{ title: t('section_suppliers', state.lang), rows }];
    return whatsappService.sendInteractiveList(from, body, t('list_trigger_suppliers', state.lang), sections);
  }

  async sendInvoiceStatusButtons(from) {
    const state = await stateService.getUserState(from);
    const body = t('invoice_status_prompt', state.lang);
    const buttons = [
      { id: 'issued', title: t('status_issued', state.lang) },
      { id: 'paid', title: t('status_paid', state.lang) }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async handleOutgoingMessage(req, res) {
    const { to, text } = req.body;
    if (!to || !text) {
        return res.status(400).json({ status: 'error', message: 'Missing to or text' });
    }

    try {
        const result = await whatsappService.sendTextMessage(to, text);
        res.json({ status: 'success', data: result });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
  }

  /**
   * Entry point for natural language reporting
   */
  async handleReportQuery(from, text) {
    const state = await stateService.getUserState(from);
    const filters = await aiService.parseReportQuery(text, from);
    
    // Safety Net: If AI incorrectly matched a month as an entity name
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    if (filters.entityName && months.includes(filters.entityName.toLowerCase())) {
      const mIdx = months.indexOf(filters.entityName.toLowerCase()) + 1;
      filters.month = mIdx;
      filters.entityName = null;
    }

    if (!filters.entityName) {
      // General status report
      await whatsappService.sendTextMessage(from, t('fetching_status', state.lang));
      const stats = await laravelService.getAccountStatus(from, filters.month, filters.year);
      const monthsLabel = state.lang === 'fr' 
        ? ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]
        : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      let periodStr = filters.month ? `${monthsLabel[filters.month-1]} ` : "";
      periodStr += filters.year || (filters.month ? "" : t('this_month', state.lang).toLowerCase());
      
      return this.sendStatusInteractive(from, stats);
    }

    // Search for entity
    await whatsappService.sendTextMessage(from, t('searching_reports', state.lang, { name: filters.entityName }));
    
    const [clients, suppliers] = await Promise.all([
      laravelService.getClients(from),
      laravelService.getSuppliers(from)
    ]);

    // 1. Strict Pass (Substring match)
    const search = filters.entityName.toLowerCase().replace(/[.,!?;:]+$/, "").trim();
    let matchedClients = (clients || []).filter(c => c.client_name.toLowerCase().includes(search));
    let matchedSuppliers = (suppliers || []).filter(s => s.name.toLowerCase().includes(search));

    // 2. Fuzzy Fallback (If no strict matches found)
    if (matchedClients.length === 0 && matchedSuppliers.length === 0) {
        logger.debug(`⚠️ No strict match for "${search}". Running fuzzy search...`);
        const threshold = 0.45; // 45% similarity for names is usually safe
        
        const fuzzyClients = (clients || [])
            .map(c => ({ ...c, score: this.calculateSimilarity(search, c.client_name) }))
            .filter(c => c.score >= threshold)
            .sort((a, b) => b.score - a.score);

        const fuzzySuppliers = (suppliers || [])
            .map(s => ({ ...s, score: this.calculateSimilarity(search, s.name) }))
            .filter(s => s.score >= threshold)
            .sort((a, b) => b.score - a.score);

        // If we found any fuzzy matches, use them
        if (fuzzyClients.length > 0 || fuzzySuppliers.length > 0) {
            // If the top score is high (e.g. > 70%), just take the top matches
            const topScore = Math.max(
                fuzzyClients[0]?.score || 0, 
                fuzzySuppliers[0]?.score || 0
            );

            if (topScore > 0.7) {
                matchedClients = fuzzyClients.filter(c => c.score === topScore);
                matchedSuppliers = fuzzySuppliers.filter(s => s.score === topScore);
            } else {
                // If fuzzy but lower confidence, include all that passed the threshold for disambiguation
                matchedClients = fuzzyClients;
                matchedSuppliers = fuzzySuppliers;
            }
        }
    }

    const totalMatches = matchedClients.length + matchedSuppliers.length;

    if (totalMatches === 0) {
      await whatsappService.sendTextMessage(from, t('error_no_match', state.lang, { name: filters.entityName }));
      return;
    }

    if (totalMatches === 1) {
      const entity = matchedClients[0] || matchedSuppliers[0];
      const isClient = !!matchedClients[0];
      return this.sendFilteredReport(from, entity, isClient, filters);
    }

    // DISAMBIGUATION: Multiple matches found
    const combined = [
      ...matchedClients.map(c => ({ id: `rep_c_${c.id}`, title: `${t('label_client', state.lang)}: ${c.client_name.substring(0,12)}` })),
      ...matchedSuppliers.map(s => ({ id: `rep_s_${s.id}`, title: `${t('label_supplier', state.lang)}: ${s.name.substring(0,13)}` }))
    ].slice(0, 3); // Max 3 buttons

    await whatsappService.sendInteractiveButtons(from, 
      t('disambiguation_title', state.lang, { name: filters.entityName }),
      combined
    );
    
    // Save filter context in state so we can pick it up when they click a button
    stateService.setUserState(from, 'AWAITING_REPORT_DISAMBIGUATION', { filters });
  }

  /**
   * Resolves disambiguation click
   */
  async handleReportDisambiguation(from, interactiveId, state) {
    const parts = interactiveId.split('_');
    if (parts.length < 3) return;

    const isClient = parts[1] === 'c';
    const entityId = parts[2];
    
    // Perform the lookup once and store in state
    const entities = isClient ? await laravelService.getClients(from) : await laravelService.getSuppliers(from);
    const entity = entities ? entities.find(e => e.id == entityId) : null;

    if (!entity) {
      await whatsappService.sendTextMessage(from, t('error_record_not_found', state.lang));
      stateService.clearUserState(from);
      return;
    }

    if (state.data.filters && (state.data.filters.month || state.data.filters.year)) {
      await this.sendFilteredReport(from, entity, isClient, state.data.filters);
      stateService.clearUserState(from);
    } else {
      // Store the full entity so AWAITING_REPORT_PERIOD can use it directly
      stateService.setUserState(from, 'AWAITING_REPORT_PERIOD', { entityId, isClient, entity });
      await this.sendReportPeriodButtons(from);
    }
  }

  /**
   * Formats and sends the actual report
   */
  async sendFilteredReport(from, entity, isClient, filters) {
    const state = await stateService.getUserState(from);
    const queryParams = {
      month: filters.month,
      year: filters.year
    };
    if (isClient) queryParams.client_id = entity.id;
    else queryParams.supplier_id = entity.id;

    const stats = await laravelService.getAccountStatus(from, queryParams.month, queryParams.year, queryParams.client_id, queryParams.supplier_id);
    
    if (!stats) {
      return whatsappService.sendTextMessage(from, t('auth_required', state.lang)); // Placeholder error
    }
    
    const name = isClient ? entity.client_name : entity.name;
    const icon = isClient ? '👤' : '🚚';
    const months = state.lang === 'fr' 
      ? ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]
      : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    let periodStr = t('all_time', state.lang);
    if (filters.month || filters.year) {
      periodStr = (filters.month ? `${months[filters.month-1]} ` : "") + (filters.year || "");
    }

    let report = `${icon} *${t('report_for', state.lang, { name })}*\n`;
    if (periodStr) report += `📅 *${t('field_period', state.lang)}:* ${periodStr}\n`;
    report += `--- \n\n`;

    if (isClient) {
      // --- CLIENT VIEW (SALES) ---
      report += `💰 *${t('field_revenue', state.lang)}:* ${(stats.salesSum || 0).toFixed(2)}\n`;
      report += `🕒 *${t('field_outstanding', state.lang)}:* ${(stats.total_unpaid_sum || 0).toFixed(2)}\n`;
      report += `📈 *${t('field_quotes', state.lang)}:* ${(stats.total_quote_sum || 0).toFixed(2)}\n`;
      report += `🏛️ *${t('field_vat_collected', state.lang)}:* ${(stats.cash_vat_sum || 0).toFixed(2)}\n`;
    } else {
      // --- SUPPLIER VIEW (PURCHASES) ---
      report += `💸 *${t('report_expenses', state.lang)}:* ${(stats.expensesSum || 0).toFixed(2)}\n`;
      report += `🏷️ *${t('field_vat_paid', state.lang)}:* ${(stats.expenseVat || 0).toFixed(2)}\n`;
      report += `📋 *${t('field_records', state.lang)}:* ${stats.expensesCount || 0}\n`;
    }

    report += `\n${t('portal_full_history', state.lang)}`;

    const monthPad = filters.month ? String(filters.month).padStart(2, '0') : '00';
    const yearPad = filters.year ? String(filters.year) : '0000';
    const listAction = isClient ? 'list_inv' : 'list_exp';
    const listButtonId = `${listAction}_${entity.id}_${monthPad}_${yearPad}`;
    const listButtonTitle = isClient ? t('btn_list_invoices', state.lang) : t('btn_list_expenses', state.lang);

    const recExpId = `record_exp_${entity.id}`;
    const recInvId = `record_inv_${entity.id}`;

    const buttons = [
      { id: listButtonId, title: listButtonTitle }
    ];
    buttons.push({ id: 'action_status', title: t('btn_status', state.lang) });

    if (isClient) {
      buttons.push({ id: recInvId, title: t('btn_record_invoice', state.lang) });
    } else {
      buttons.push({ id: recExpId, title: t('btn_record_expense', state.lang) });
    }

    await whatsappService.sendInteractiveButtons(from, report, buttons);
  }

  /**
   * Drill-down handler for specific transaction lists
   */
  async handleListTransactions(from, type, entityId, month, year) {
    const state = await stateService.getUserState(from);
    try {
      // 1. Fetch data
      let transactions = [];
      let title = "";

      if (type === 'inv') {
        transactions = await laravelService.getInvoices(from, null, month, year, entityId);
        title = t('recent_invoices', state.lang);
      } else {
        transactions = await laravelService.getExpenses(from, month, year, entityId);
        title = t('recent_expenses', state.lang);
      }

      if (transactions.length === 0) {
        return whatsappService.sendTextMessage(from, t('no_transactions_found', state.lang));
      }

      // 2. Format list
      const months = state.lang === 'fr' 
        ? ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]
        : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      
      const periodStr = month ? `${months[month-1]} ${year || ''}` : (year ? year : t('all_time', state.lang));
      
      let totalSum = 0;
      let currency = 'MAD';

      transactions.forEach(t => {
          let amount = 0;
          if (type === 'inv') {
              amount = (t.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
          } else {
              amount = parseFloat(t.total_ttc || t.ttc || 0);
          }
          totalSum += amount;
          if (t.currency) currency = t.currency;
      });

      const rows = transactions.slice(0, 10).map((t) => {
        const date = t.date ? new Date(t.date).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB') : 'N/A';
        
        let amount = 0;
        if (type === 'inv') {
          amount = (t.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
        } else {
          amount = parseFloat(t.total_ttc || t.ttc || 0);
        }

        const fmtAmount = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + (t.currency || currency);
        const prefix = type === 'inv' ? 'v_inv_' : 'v_exp_';

        return {
           id: `${prefix}${t.id}`,
           title: `${date} — ${fmtAmount}`,
           description: t.notes || (type === 'inv' ? `${t('field_invoice_num', state.lang)} #${t.id}` : `${t('field_expense_num', state.lang)} #${t.id}`)
        };
      });

      const fmtTotal = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(totalSum) + ' ' + currency;
      
      const bodyText = `*${title}*\n` +
                       `📅 *${t('field_period', state.lang)}:* ${periodStr}\n` +
                       `💰 *Total:* ${fmtTotal}\n\n` +
                       t('records_found_msg', state.lang, { count: transactions.length });

      const sections = [{
          title: t('select_document', state.lang),
          rows: rows
      }];

      await whatsappService.sendInteractiveList(from, bodyText, t('view_documents', state.lang), sections);

    } catch (error) {
      console.error('handleListTransactions error:', error);
      await whatsappService.sendTextMessage(from, t('error_fetching_transactions', state.lang));
    }
  }
  /**
   * Fetch and deliver a specific invoice or expense document natively
   */
  async handleDeliverSpecificMedia(from, type, id) {
    const state = await stateService.getUserState(from);
    try {
      let document = null;
      let label = "";

      if (type === 'inv') {
        const results = await laravelService.getInvoices(from, null, null, null, null, id);
        document = results.length > 0 ? results[0] : null;
        label = "Invoice";
      } else {
        const results = await laravelService.getExpenses(from, null, null, null, id);
        document = results.length > 0 ? results[0] : null;
        label = "Expense";
      }

      if (!document || !document.download_url) {
        return whatsappService.sendTextMessage(from, t('error_media_delivery', state.lang, { label, id }));
      }

      const date = document.date ? new Date(document.date).toLocaleDateString('en-GB') : 'N/A';
      
      // Calculate amount
      let amount = 0;
      if (type === 'inv') {
        amount = (document.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
      } else {
        amount = parseFloat(document.total_ttc || document.ttc || 0);
      }
      const currency = document.currency || 'MAD';
      const fmtAmount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + currency;
      const entityName = type === 'inv' ? (document.client?.client_name || 'N/A') : (document.supplier?.supplier_name || 'N/A');
      const entityLabelText = type === 'inv' ? t('label_client', state.lang) : t('label_supplier', state.lang);
      const notesText = document.notes || document.description || 'N/A';

      const successText = `🧾 *${t('media_doc_title', state.lang, { label: label.toUpperCase() })}*\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🏢 *${entityLabelText}:* ${entityName}\n` +
                          `💰 *${t('field_amount', state.lang)}:* ${fmtAmount}\n` +
                          `📅 *${t('field_date', state.lang)}:* ${date}\n` +
                          `📝 *${t('field_notes', state.lang)}:* ${notesText}\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `✅ *Status:* ${document.status || t('recorded_successfully_short', state.lang)}`;
      
      const isPdfRoute = document.download_url.includes('/pdf');
      const isImage = document.document_path && (
          document.document_path.toLowerCase().endsWith('.jpg') || 
          document.document_path.toLowerCase().endsWith('.jpeg') || 
          document.document_path.toLowerCase().endsWith('.png')
      );

      if (!isPdfRoute && isImage) {
          await whatsappService.sendImage(from, document.download_url, successText);
      } else {
          const extension = document.document_path ? path.extname(document.document_path) : '.pdf';
          await whatsappService.sendDocument(from, document.download_url, `${label}_${id}${extension}`, successText);
      }

    } catch (error) {
      console.error('handleDeliverSpecificMedia error:', error);
      await whatsappService.sendTextMessage(from, t('error_lost_track', state.lang)); // Generic error fallback
    }
  }
}

module.exports = new WhatsAppController();
