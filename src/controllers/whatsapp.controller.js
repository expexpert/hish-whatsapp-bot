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
          const profile = await laravelService.checkAuth(from);
          if (profile) {
            isAuth = true;
            stateService.setAuthStatus(from, true);
            
            // Sync Database Language to Local State
            if (profile.bot_lang || profile.lang) {
                const preference = profile.bot_lang || profile.lang;
                stateService.setLanguage(from, preference, false); // false = Don't push back to DB
                
                // Mark as chosen for this session immediately to skip onboarding
                const sessionState = await stateService.getUserState(from);
                sessionState.data.languageChosen = true;
                await stateService.setUserState(from, sessionState.state, sessionState.data);
            }
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
              stateService.setUserState(from, state.state, { ...state.data, lastWarned: now });
          }
          return;
      }

      const type = message.type;
      let state = await stateService.getUserState(from);

      // --- LANGUAGE ONBOARDING CHECK ---
      // If language preference isn't confirmed for this session and isn't currently prompted
      if (!state.data.languageChosen && state.state !== 'AWAITING_LANGUAGE') {
          // LAZY SYNC: If we are authed but flag is missing, check DB one last time before prompting
          const profile = await laravelService.checkAuth(from);
          if (profile && (profile.bot_lang || profile.lang)) {
              const preference = profile.bot_lang || profile.lang;
              stateService.setLanguage(from, preference, false);
              state.data.languageChosen = true;
              await stateService.setUserState(from, state.state, state.data);
          } else {
              return this.promptLanguageSelection(from);
          }
      }
      
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

        // --- 2. VAT SELECTION HANDLER (Forced Flow) ---
        if (interactiveId && interactiveId.startsWith('set_vat_')) {
          const vatId = parseInt(interactiveId.replace('set_vat_', ''));
          const state = await stateService.getUserState(from);
          
          if (state.data.invoiceData) {
            // Fetch names to show in Review
            const resources = await laravelService.getTaxes(from);
            const selectedTax = resources?.tax?.find(t => parseInt(t.id) === vatId);
            
            state.data.invoiceData.tva_id = vatId;
            if (selectedTax) {
                // Localize the name (VAT -> TVA) for FR users
                const rawName = selectedTax.name || `${selectedTax.rate}%`;
                state.data.invoiceData.tva_name = this.localizeTaxName(rawName, state.lang);
                state.data.invoiceData.tva_percentage = selectedTax.rate;
            }
          }
          await stateService.setUserState(from, state.state, state.data);
          
          // Resume flow
          return this.handleDocumentRouting(from, {}, state.data.filePath, 'invoice');
        }

        // --- LANGUAGE SELECTION HANDLER ---
        if (interactiveId === 'lang_en' || interactiveId === 'lang_fr') {
            const lang = interactiveId === 'lang_en' ? 'en' : 'fr';
            stateService.setLanguage(from, lang);
            await laravelService.updateLanguage(from, lang); // Sync to DB
            
            // Mark as chosen and return to IDLE
            await stateService.setUserState(from, 'IDLE', { languageChosen: true });
            
            // Send welcome menu in the new language
            return this.sendWelcomeMenu(from);
        }

        // --- LANGUAGE SWITCH CONFIRMATION ---
        if (interactiveId === 'switch_yes' || interactiveId === 'switch_no') {
            const originalData = state.data.originalRequest;
            if (interactiveId === 'switch_yes') {
                stateService.setLanguage(from, state.data.newLang);
                await laravelService.updateLanguage(from, state.data.newLang); // Sync to DB
            }
            
            // Clear the switch state but keep the chosen flag
            await stateService.setUserState(from, 'IDLE', { languageChosen: true });
            
            // Re-process the original message if it exists
            if (originalData) {
                originalData._skipLanguagePrompt = true;
                return this.processMessage(originalData);
            }
            return this.sendWelcomeMenu(from);
        }

        // --- FAST KEYWORD LANGUAGE DETECTION & PROMPTING ---
        // Instantly detects common words and prompts the user without wasting AI tokens if languages mismatch.
        const frenchKeywords = ['bonjour', 'salut', 'coucou', 'statut', 'solde', 'tableau', 'compte', 'début', 'annuler', 'état', 'facture', 'dépense', 'rapport', 'résumé', 'accueil'];
        const englishKeywords = ['hi', 'hello', 'status', 'dashboard', 'start', 'invoice', 'expense', 'report'];
        const universalKeywords = ['menu'];
        
        let manualLanguageSwitched = false;
        
        const isIdleOrLangPrompt = state.state === 'IDLE' || state.state === 'AWAITING_LANGUAGE_OVERRIDE';
        
        if (isIdleOrLangPrompt && !interactiveId) {
            const normalizedText = textLower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            
            // 1. Check Universal Words (No language switch possible)
            if (universalKeywords.includes(textLower)) {
                manualLanguageSwitched = true; 
            } else {
                // 2. Check French Words
                const matchesFrench = frenchKeywords.some(k => {
                    const normalizedK = k.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    return normalizedText === normalizedK || normalizedText.includes(normalizedK);
                });

                if (matchesFrench && text.split(' ').length <= 2) {
                    if (state.lang !== 'fr' && !message._skipLanguagePrompt) {
                        return this.promptLanguageSwitch(from, 'fr', message);
                    }
                    manualLanguageSwitched = true; 
                } else if (englishKeywords.includes(textLower) && text.split(' ').length <= 2) {
                    // 3. Check English Words
                    if (state.lang !== 'en' && !message._skipLanguagePrompt) {
                        return this.promptLanguageSwitch(from, 'en', message);
                    }
                    manualLanguageSwitched = true; 
                }
            }
        }

        // --- SMART LANGUAGE DETECTION ---
        // For conversational inputs not caught by the fast dictionary
        if (!manualLanguageSwitched && isIdleOrLangPrompt && !interactiveId && text.length >= 4 && !message._skipLanguagePrompt) {
            const detected = await aiService.detectLanguage(text, from, false, state.lang);
            
            // SECURITY GUARD: Only switch if its different from current lang 
            // and definitively NOT unknown.
            if (detected !== 'unknown' && detected !== state.lang) {
                return this.promptLanguageSwitch(from, detected, message); 
            }
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

        // --- PRIORITY PROTECTION FOR INTERACTIVE MENUS & FRENCH FLOW ---
        // Prevents "Modifier" (Edit) or "Confirmer" from being misclassified 
        // by AI as a "New Expense/Invoice" intent, which would clear the state.
        const isCoreFrenchAction = state.lang === 'fr' && (isEdit || isConfirm || isCancel);
        
        if (interactiveId === 'quick_reports') {
            // Force priority for exact menu button interactions to avoid NLP regex conflicts
            detectedIntent = 'reports_menu';
        } else if (textLower.startsWith('how much') || textLower.startsWith('combien') || textLower.startsWith('rapport') || 
            textLower.includes('summary') || textLower.includes('résumé') || 
            ((textLower.includes('statement') || textLower.includes('relevé')) && (textLower.includes('for') || textLower.includes('pour') || textLower.includes('from') || textLower.includes('de')))) {
            detectedIntent = 'report';
        } else if (isCoreFrenchAction && state.state !== 'IDLE') {
            detectedIntent = null; // Prioritize local state handling over global intent interceptor
            logger.debug(`🛡️ FRENCH CORE ACTION DETECTED (${text}): Bypassing global intent detection.`);
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
            const greetings = ['hi', 'hello', 'hey', 'bonjour', 'salam', 'ola', 'ça va', 'ca va', 'salut', 'coucou'];
            if (!greetings.includes(textLower)) {
                // Returns { intent, lang }
                const aiResult = await aiService.classifyIntent(text, from, true);
                
                // --- UPDATE LANGUAGE (with Safety Check) ---
                if (aiResult && aiResult.lang && aiResult.lang !== state.lang) {
                    stateService.setLanguage(from, aiResult.lang);
                    state.lang = aiResult.lang; // Update local reference
                }

                // If keywords didn't find anything, let AI set the intent
                if (aiResult && !detectedIntent && aiResult.intent && aiResult.intent !== 'UNKNOWN' && aiResult.intent !== 'MENU') {
                    detectedIntent = aiResult.intent.toLowerCase();
                    logger.debug(`🤖 AI SENSING OVERRIDE: -> ${detectedIntent}`);
                }
            }
        }

        // (Manual language switching was moved up to execute before AI Language Detection for optimization)

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
                        const stats = await laravelService.getAccountStatus(from, null, null, null, state.lang);
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
            const aiIntent = aiResult?.intent;

            if (aiIntent !== 'UNKNOWN' && aiIntent !== 'MENU') {
                // Check and update language if AI detected a switch
                if (aiResult && aiResult.lang && aiResult.lang !== state.lang) {
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
                if (result.data) {
                    // 1. Prioritize the official Generated PDF Report from the backend
                    let downloadUrl = result.data.download_url || result.data.pdf_url || `${config.botPublicUrl}/api/bot/invoice/pdf/${result.data.id}`;
                    
                    // 2. Only fallback to the original 'document' if the report wasn't specifically returned
                    // but we generally PREFER the report (PDF) for successful submission
                    if (!result.data.download_url && result.data.document_path) {
                        if (String(result.data.document_path).startsWith('http')) {
                            downloadUrl = result.data.document_path;
                        } else {
                            const pathBase = String(result.data.document_path).replace('public/', '').replace('storage/', '');
                            downloadUrl = `${config.botPublicUrl}/storage/${pathBase}`;
                        }
                    }

                    // 3. CRITICAL: Rewrite any internal routes to the public domain so Meta can reach them
                    if (downloadUrl && (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1'))) {
                        downloadUrl = downloadUrl.replace(/http(s)?:\/\/(localhost|127\.0\.0\.1):[0-9]+/, config.botPublicUrl);
                    }
                    
                    const isLocal = false;
                    
                    try {
                        const date = result.data.date ? new Date(result.data.date).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB') : 'N/A';
                        
                        // Calculate total from articles (consistent with list logic)
                        const articles = result.data.articles || result.data.items || result.data.invoice_products || [];
                        const amount = articles.reduce((sum, art) => sum + parseFloat(art.total_price_ht || art.price_ht || 0), 0) || parseFloat(result.data.total_ttc || result.data.amount || 0);
                        const currency = result.data.currency || state.data.invoiceData.currency || 'MAD';
                        
                        const fmtAmount = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + currency;
                        const entityName = result.data.client_name || state.data.invoiceData.client_name || result.data.entity || 'N/A';
                        
                        // Universal VAT Discovery (Prioritize Combined Mathematical Consistency)
                        const resData = result.data || {};
                        const tvaRate = parseFloat(resData.tax_rate || resData.tva_percentage || resData.tax_percentage || state.data.invoiceData.tva_percentage || 0);

                        // Calculate Expected VAT based on the final HT amount
                        const amountHT = articles.reduce((sum, art) => sum + parseFloat(art.total_price_ht || art.price_ht || 0), 0) || parseFloat(result.data.amount || 0);
                        let tvaAmount = amountHT * (tvaRate / 100);
                        
                        // Fallback: If calculation is 0, attempt to pull from backend fields (but math is preferred)
                        if (tvaAmount === 0) {
                            tvaAmount = parseFloat(resData.tax_amount || resData.total_tva || resData.total_tax || resData.tax_price || 0);
                        }
                        
                        const fmtVat = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(tvaAmount) + ' ' + currency;
                        const vatLabel = state.lang === 'fr' ? 'TVA' : 'VAT';

                        const successText = `🧾 *${t('invoice_recorded_header', state.lang)}*\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `🏢 *${t('field_entity_client', state.lang)}:* ${entityName}\n` +
                                            `💰 *${t('field_amount', state.lang)}:* ${fmtAmount}\n` +
                                            `📉 *${vatLabel} (${tvaRate}%):* ${fmtVat}\n` +
                                            `📅 *${t('field_date', state.lang)}:* ${date}\n` +
                                            `📝 *${t('field_notes', state.lang)}:* ${result.data.notes || result.data.description || 'N/A'}\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `✅ *Status:* ${t('recorded_successfully', state.lang)}`;

                        // Force the delivery of the text receipt immediately to bypass any Ngrok/Media Meta drops
                        await whatsappService.sendTextMessage(from, successText);

                        const isPdfRoute = downloadUrl.includes('/pdf');
                        const isImage = result.data.document_path && (
                            result.data.document_path.toLowerCase().endsWith('.jpg') || 
                            result.data.document_path.toLowerCase().endsWith('.jpeg') || 
                            result.data.document_path.toLowerCase().endsWith('.png')
                        );
                        
                        let waResult;
                        if (!isPdfRoute && isImage) {
                            // If it's explicitly an image and NOT a generated PDF route, attach it without duplicating text
                            waResult = await whatsappService.sendImage(from, downloadUrl);
                        } else {
                            // Otherwise send as document with dynamic extension
                            const extension = result.data.document_path ? path.extname(result.data.document_path) : '.pdf';
                            const filename = `Invoice_${result.data.id || 'Draft'}${extension}`;
                            waResult = await whatsappService.sendDocument(from, downloadUrl, filename);
                        }
                    } catch (waErr) {
                        // The text message would have already succeeded above
                        logger.error("Media failed to deliver, but text succeeded: " + waErr.message);
                    }
                } else {
                    await whatsappService.sendTextMessage(from, `✅ *${t('recorded_successfully', state.lang)}*`);
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
          } else if (interactiveId === 'vat' || textLower === 'vat') {
            await this.sendVatSelectionList(from);
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
            state.state === 'AWAITING_INVOICE_DATE' || state.state === 'AWAITING_INVOICE_AMOUNT') {
            
            const isInvoice = state.state.endsWith('_INVOICE') || state.state.startsWith('AWAITING_INVOICE_');
            const dataObj = isInvoice ? state.data.invoiceData : state.data.expenseData;

            if (state.state.startsWith('AWAITING_AMOUNT_EDIT') || state.state === 'AWAITING_INVOICE_AMOUNT') {
                const amountNum = parseFloat(text.replace(/[^0-9.]/g, ''));
                if (!isNaN(amountNum)) dataObj.amount = amountNum;
            } else if (state.state === 'AWAITING_INVOICE_DATE') {
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
            await stateService.setUserState(from, state.state, state.data);
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        if (state.state === 'AWAITING_INVOICE_STATUS' && !detectedIntent) {
            state.data.invoiceData.status = interactiveId ? interactiveId.toUpperCase() : text.toUpperCase();
            await stateService.setUserState(from, state.state, state.data);
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        // --- Handle Invoice Product Selection ---
        if (state.state === 'AWAITING_INVOICE_PRODUCT' && !detectedIntent) {
            const productId = (interactiveId && String(interactiveId).startsWith('inv_p_')) ? String(interactiveId).replace('inv_p_', '') : null;
            if (productId) {
                state.data.invoiceData.product_id = parseInt(productId);
                // If it's a specific product, use its title as the designation if not already set
                if (!state.data.invoiceData.description || state.data.invoiceData.description === 'No description') {
                    state.data.invoiceData.description = text;
                }
            } else {
                 // Text entry fallback - try to resolve
                 const match = await this.resolveProductFromName(from, text);
                 if (match) {
                     state.data.invoiceData.product_id = match.id;
                 } else {
                     // If still no match, we keep it as a designation but product_id remains missing
                     // which will re-trigger the selection list in routing.
                     state.data.invoiceData.description = text;
                 }
            }
            await stateService.setUserState(from, state.state, state.data);
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
            const parsed = await aiService.parseExpenseText(text, [], from, true, state.lang);
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
                // Pass true to skipCooldown because we already checked quota in the intent sensing above
                const data = await aiService.parseExpenseText(text, categories, from, true, state.lang);
                // Ensure audioPath is passed so voice notes are linked as proof
                await this.handleDocumentRouting(from, data, audioPath || null, type);
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
                        data = { documentType }; // Don't overwrite description with technical name
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
                // Don't overwrite description here either
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
    if (!data) data = {};
    const state = await stateService.getUserState(from);
    logger.debug(`[DEBUG] ROUTING START - State: ${state?.state}`);
    const existingData = (state && state.data) ? (state.data.expenseData || state.data.invoiceData || {}) : {};
    logger.debug(`[DEBUG] Existing Data:`, existingData);
    const today = new Date().toISOString().split('T')[0];
    const invalidVals = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined', '', null];

    // --- 1. ROBUST SMART MERGE (New > Session) ---
    const isCapturing = state && state.state !== 'IDLE';
    let mergedData = { ...data };
    
    if (isCapturing) {
        const fields = [
            'amount', 'currency', 'date', 'status', 'payment_method', 
            'notes', 'description', 'documentType',
            'client_id', 'client_name', 'entity', 
            'supplier_id', 'supplier_name', 'category', 'category_id',
            'tva_id', 'tva_percentage', 'tva_name', 'vat', 'product_id'
        ];
        fields.forEach(f => {
            const newVal = mergedData[f];
            const oldVal = existingData[f];
            // If new is missing/invalid, and old exists, use old.
            if ((newVal === undefined || newVal === null || invalidVals.includes(String(newVal).toLowerCase())) && 
                (oldVal !== undefined && oldVal !== null)) {
                mergedData[f] = oldVal;
            }
        });
        
        // --- 1.1 DEPENDENCY INVALIDATION (Avoid Sticky IDs) ---
        // If the NEW extraction (data) contains a master field, force clear its ID counterpart
        // so the Proactive Resolver can do its job on the new value.
        const isNewVat = data.vat !== undefined && data.vat !== null && !invalidVals.includes(String(data.vat).toLowerCase());
        const isNewClient = (data.client_name || data.entity) && !invalidVals.includes(String(data.client_name || data.entity).toLowerCase());
        const isNewSupplier = (data.supplier_name || data.entity) && !invalidVals.includes(String(data.supplier_name || data.entity).toLowerCase());
        const isNewAmount = data.amount !== undefined && data.amount !== null && parseFloat(data.amount) > 0;

        if (isNewVat || isNewAmount) {
            delete mergedData.tva_id;
            delete mergedData.tva_percentage;
            delete mergedData.tva_name;
        }
        if (isNewClient) {
            delete mergedData.client_id;
        }
        if (isNewSupplier) {
            delete mergedData.supplier_id;
        }

        // Forced Type Preservation
        if (!mergedData.documentType) {
            if (state.state.includes('INVOICE')) mergedData.documentType = 'INVOICE';
            else if (state.state.includes('EXPENSE')) mergedData.documentType = 'EXPENSE';
            else if (state.state.includes('STATEMENT')) mergedData.documentType = 'STATEMENT';
        }
    } else {
        // Handle initial WhatsApp default
        if (!mergedData.payment_method) mergedData.payment_method = 'WhatsApp';
    }

    // --- 2. MEMOIZATION HELPERS ---
    let cachedSuppliers = null;
    let cachedClients = null;
    let cachedProducts = null;
    const fetchSuppliers = async () => {
      if (!cachedSuppliers) cachedSuppliers = await laravelService.getSuppliers(from);
      return cachedSuppliers;
    };
    const fetchClients = async () => {
      if (!cachedClients) cachedClients = await laravelService.getClients(from);
      return cachedClients;
    };
    const fetchProducts = async () => {
      if (!cachedProducts) cachedProducts = await laravelService.getProducts(from);
      return cachedProducts;
    };

    // --- 3. NORMALIZATION & FUZZY LOOKUP ---
    const sanitize = (val) => val ? String(val).toLowerCase().replace(/[.!]$/, '').trim() : '';
    
    // A. Proactive Tax Resolution (Resolve text rates to DB IDs immediately)
    if (!mergedData.tva_id && (mergedData.vat !== null && mergedData.vat !== undefined)) {
        const taxMatch = await this.resolveTaxFromRate(from, mergedData.vat, mergedData.amount);
        if (taxMatch) {
            mergedData.tva_id = taxMatch.id;
            mergedData.tva_percentage = taxMatch.rate;
            mergedData.tva_name = this.localizeTaxName(taxMatch.name, state.lang);
            logger.debug(`🎯 SMART TAX AUTO-SELECTED (Math Aware): ${taxMatch.rate}% (ID: ${taxMatch.id})`);
        }
    }

    if (mergedData.documentType === 'INVOICE' || type === 'invoice') {
        if (mergedData.entity && !mergedData.client_name) mergedData.client_name = mergedData.entity;
        
        // A. Client Resolution
        if (mergedData.client_name && !mergedData.client_id) {
            const clients = await fetchClients();
            const searchName = sanitize(mergedData.client_name);
            const match = (clients || []).find(c => sanitize(c.company_name) === searchName || sanitize(c.client_name) === searchName);
            if (match) {
                mergedData.client_id = match.id;
                mergedData.client_name = match.company_name || match.client_name;
            }
        }

        // B. NEW: Product Resolution (Treating Product as Category for Invoices)
        // If the AI returned a 'category' or 'description', try to map it to a DB product.
        if (!mergedData.product_id) {
            const productMatch = await this.resolveProductFromName(from, mergedData.category || mergedData.description);
            if (productMatch) {
                mergedData.product_id = productMatch.id;
                // If the product has a specific name, we can use it as designation or keep the user's
                logger.debug(`🎯 SMART PRODUCT AUTO-SELECTED: ${productMatch.name} (ID: ${productMatch.id})`);
            }
        }
    } else if (mergedData.documentType === 'EXPENSE') {
        if (mergedData.entity && !mergedData.supplier_id) {
            const suppliers = await fetchSuppliers();
            const searchName = sanitize(mergedData.entity);
            const match = (suppliers || []).find(s => sanitize(s.name) === searchName);
            if (match) {
                mergedData.supplier_id = match.id;
                mergedData.entity = match.name;
            }
        }
        
        // B. NEW: Category Resolution (Ensures only DB categories are used)
        if (mergedData.category && !mergedData.category_id) {
            const catMatch = await this.resolveCategoryFromName(from, mergedData.category);
            if (catMatch) {
                mergedData.category_id = catMatch.id;
                mergedData.category = catMatch.name;
                logger.debug(`🎯 SMART CATEGORY AUTO-SELECTED: ${catMatch.name} (ID: ${catMatch.id})`);
            } else {
                // Not found - clear so it triggers interactive selection
                logger.debug(`⚠️ CATEGORY NOT FOUND IN DB: ${mergedData.category}. Clearing for selection.`);
                delete mergedData.category;
            }
        }
    }

    // Status Resolution
    if (mergedData.status) {
        const s = String(mergedData.status).toLowerCase();
        if (s.includes('paid') && !s.includes('unpaid')) mergedData.status = 'Paid';
        else if (s.includes('unpaid')) mergedData.status = 'Unpaid';
    }

    // --- 🛣️ ROUTING HIERARCHY ---

    if (type === 'status') {
        const d = new Date();
        const month = d.getMonth() + 1;
        const year = d.getFullYear();
        await this.sendFilteredReport(from, null, false, { month, year });
    } else if (mergedData.documentType === 'STATEMENT') {
        const monthYear = mergedData.monthYear || (isCapturing && (state.data?.monthYear));
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
    } else if (mergedData.documentType === 'INVOICE' || type === 'invoice') {
        const inv = mergedData;

        const isAudio = filePath && filePath.endsWith('.ogg');
        if (!inv.amount || parseFloat(inv.amount) <= 0) {
            if (!filePath || isAudio) {
                const source = isAudio ? t('voice_note', state.lang).toLowerCase() : t('btn_menu', state.lang).toLowerCase();
                await whatsappService.sendTextMessage(from, t('error_no_amount_found', state.lang, { source }));
            } else {
                stateService.setUserState(from, 'AWAITING_INVOICE_AMOUNT', { filePath, invoiceData: inv });
                await whatsappService.sendTextMessage(from, t('error_invalid_amount', state.lang));
            }
        } else if (!inv.date) {
            stateService.setUserState(from, 'AWAITING_INVOICE_DATE', { filePath, invoiceData: inv });
            await whatsappService.sendTextMessage(from, t('prompt_invoice_date', state.lang));
        } else if (!inv.client_id && (!inv.client_name || invalidVals.includes(String(inv.client_name).toLowerCase()))) {
            const clients = await fetchClients();
            stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', { filePath, invoiceData: inv });
            await this.sendClientSelectionList(from, clients);
        } else if (!inv.payment_method || invalidVals.includes(String(inv.payment_method).toLowerCase()) || String(inv.payment_method).toLowerCase() === 'whatsapp') {
            stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', { filePath, invoiceData: inv });
            await this.sendPaymentMethodSelectionList(from, 'INVOICE');
        } else if (!inv.status || invalidVals.includes(String(inv.status).toLowerCase())) {
            stateService.setUserState(from, 'AWAITING_INVOICE_STATUS', { filePath, invoiceData: inv });
            await this.sendInvoiceStatusButtons(from);
        } else {
            if (!inv.product_id) {
                const products = await fetchProducts();
                stateService.setUserState(from, 'AWAITING_INVOICE_PRODUCT', { filePath, invoiceData: inv });
                await this.sendProductSelectionList(from, products);
            } else if (!inv.tva_id) {
                stateService.setUserState(from, 'AWAITING_INVOICE_VAT', { invoiceData: inv, filePath });
                await this.sendVatSelectionList(from);
            } else {
                stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', { filePath, invoiceData: inv });
                await this.sendInvoiceReviewButtons(from, inv, filePath);
            }
        }
    } else if (mergedData.amount || filePath) {
        const exp = mergedData;
        if (!exp.date) exp.date = today;

        if (!exp.amount || parseFloat(exp.amount) <= 0) {
            stateService.setUserState(from, 'AWAITING_EXPENSE_AMOUNT', { expenseData: exp, receiptPath: filePath });
            await whatsappService.sendTextMessage(from, t('error_invalid_amount', state.lang));
        } else if (!exp.category || invalidVals.includes(String(exp.category).toLowerCase())) {
            const categories = await laravelService.getCategories(from);
            stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', { expenseData: exp, receiptPath: filePath });
            await this.sendCategorySelectionList(from, categories);
        } else if (!exp.payment_method || invalidVals.includes(String(exp.payment_method).toLowerCase()) || String(exp.payment_method).toLowerCase() === 'whatsapp') {
            stateService.setUserState(from, 'AWAITING_EXPENSE_PAYMENT_METHOD', { expenseData: exp, receiptPath: filePath });
            await this.sendPaymentMethodSelectionList(from, 'EXPENSE');
        } else {
            stateService.setUserState(from, 'AWAITING_EXPENSE_CONFIRMATION', { expenseData: exp, receiptPath: filePath });
            await this.sendExpenseReviewButtons(from, exp, filePath);
        }
    } else {
        if (state && state.state !== 'IDLE') {
            await whatsappService.sendTextMessage(from, t('error_parsing_failed', state.lang));
        } else {
            await this.sendWelcomeMenu(from);
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
          const stats = await laravelService.getAccountStatus(from, null, null, null, state.lang);
          await this.sendStatusInteractive(from, stats);
      } else if (interactiveId === 'rep_gen_unpaid') {
          const stats = await laravelService.getAccountStatus(from, null, null, null, state.lang);
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
          const currentState = await stateService.getUserState(from);
          
          const entities = isClient ? await laravelService.getClients(from) : await laravelService.getSuppliers(from);
          const entity = entities ? entities.find(e => e.id == entityId) : null;
          
          if (!entity) {
              stateService.clearUserState(from);
              return whatsappService.sendTextMessage(from, t('error_record_not_found', currentState.lang));
          }

          // INTELLIGENT DISAMBIGUATION: Carry over search filters if they exist
          if (currentState.state === 'AWAITING_REPORT_DISAMBIGUATION' && currentState.data.filters) {
              const filters = currentState.data.filters;
              stateService.clearUserState(from);
              return this.sendFilteredReport(from, entity, isClient, filters);
          }
          
          // Default: ask for period
          stateService.setUserState(from, 'AWAITING_REPORT_PERIOD', { entityId, isClient, entity });
          await this.sendReportPeriodButtons(from);
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

  async promptLanguageSelection(from) {
      // First-time onboarding language pick
      await stateService.setUserState(from, 'AWAITING_LANGUAGE', {});
      const buttons = [
          { id: 'lang_en', title: t('btn_lang_en', 'en') },
          { id: 'lang_fr', title: t('btn_lang_fr', 'en') }
      ];
      await whatsappService.sendInteractiveButtons(from, t('welcome_language', 'fr'), buttons);
  }

  async promptLanguageSwitch(from, newLang, originalMessage) {
      const state = await stateService.getUserState(from);
      await stateService.setUserState(from, 'AWAITING_LANGUAGE_OVERRIDE', { 
          newLang, 
          originalRequest: originalMessage 
      });

      const buttons = [
          { id: 'switch_yes', title: t('btn_switch_yes', state.lang) },
          { id: 'switch_no', title: t('btn_switch_no', state.lang) }
      ];
      await whatsappService.sendInteractiveButtons(from, t('lang_switch_detected', state.lang), buttons);
  }

  async sendStatusInteractive(from, stats) {
    const state = await stateService.getUserState(from);
    const { targetMonth, targetYear } = stats;

    // 1. Parallel fetch details (Invoices, Expenses, Statements) - Synchronized with target period
    let [invoices, expenses, statements] = await Promise.all([
      laravelService.getInvoices(from, 'ISSUED', targetMonth, targetYear),
      laravelService.getExpenses(from, targetMonth, targetYear),
      laravelService.getBankStatements(from, targetMonth, targetYear)
    ]);

    // Bot-Side Enforcement: The Live PHP API sometimes ignores the search filter and returns all statements.
    // We strictly enforce the search locally so '03-2026' doesn't bleed into '01-2024' reports.
    if (targetMonth && targetYear) {
        const expectedFormat = `${String(targetMonth).padStart(2, '0')}-${targetYear}`;
        statements = statements.filter(s => s.month_year === expectedFormat);
    } else if (targetYear && !targetMonth) {
        statements = statements.filter(s => String(s.month_year).endsWith(String(targetYear)));
    }

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

    let body = `📊 *${t('report_title', state.lang)} : ${stats.month}*\n` +
               `━━━━━━━━━━━━━━━━━━\n\n` +
               `💰 *${t('report_income', state.lang)} :* ${fmt(income)}\n` +
               `📉 *${t('report_expenses', state.lang)} :* ${fmt(expensesTotal)}\n` +
               `✨ *${t('report_balance', state.lang)} : ${fmt(balance)}*\n\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🏛️ *${t('report_tax', state.lang)}*\n` +
               `👉 *${t('report_vat', state.lang)} : ${fmt(vat)}*\n\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📈 *${t('report_progress', state.lang)}*\n` +
               `* ${t('report_status', state.lang)} : ${statusIcon} ${statusText}\n\n` +
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

    // --- Official Tax Calculation (HT + TVA = TTC) ---
    const total_ht = parseFloat(invoiceData.amount || 0);
    const tva_rate = parseFloat(invoiceData.tva_percentage || 0);
    const tva_amount = total_ht * (tva_rate / 100);
    const total_ttc = total_ht + tva_amount;

    const locale = state.lang === 'fr' ? 'fr-FR' : 'en-US';
    const fmt = (val) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(val) + ' ' + (invoiceData.currency || 'MAD');

    let body = `*${t('review_invoice', state.lang)}*\n\n` +
      `*${t('field_total_ht', state.lang)}:* ${fmt(total_ht)}\n` +
      `*${t('field_tva_amount', state.lang)} (${tva_rate}%):* ${fmt(tva_amount)}\n` +
      `*${t('field_total_ttc', state.lang)}:* ${fmt(total_ttc)}\n\n` +
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

    if (isInvoice) {
      rows.splice(3, 0, { id: 'vat', title: t('field_vat', state.lang) });
    }

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
        title: (client.company_name || client.client_name).substring(0, 24)
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
        title: s.name.substring(0, 24)
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
    
    if (!filters.entityName) {
      // General status report
      await whatsappService.sendTextMessage(from, t('fetching_status', state.lang));
      const stats = await laravelService.getAccountStatus(from, filters.month, filters.year, null, state.lang);
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

    logger.debug(`🔍 Search entities for "${filters.entityName}" among ${clients.length} clients and ${suppliers.length} suppliers`);

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
    // Count occurrences of each name to detect collisions
    const counts = {};
    [...matchedClients, ...matchedSuppliers].forEach(e => {
        const name = (e.client_name || e.name || 'Unknown').trim();
        counts[name] = (counts[name] || 0) + 1;
    });

    const combined = [
      ...matchedClients.map(c => {
          const name = c.client_name.trim();
          const prefix = "C: ";
          const idSuffix = counts[name] > 1 ? ` #${c.id}` : "";
          const availableSpace = 20 - prefix.length - idSuffix.length;
          const displayName = name.substring(0, availableSpace).trim();
          return { id: `rep_c_${c.id}`, title: `${prefix}${displayName}${idSuffix}` };
      }),
      ...matchedSuppliers.map(s => {
          const name = s.name.trim();
          const prefix = "S: ";
          const idSuffix = counts[name] > 1 ? ` #${s.id}` : "";
          const availableSpace = 20 - prefix.length - idSuffix.length;
          const displayName = name.substring(0, availableSpace).trim();
          return { id: `rep_s_${s.id}`, title: `${prefix}${displayName}${idSuffix}` };
      })
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

    // Item-Derived Aggregation & Tax Mappings (Bypass Live API missing relationship)
    const [invoices, expenses, taxResources] = await Promise.all([
        laravelService.getInvoices(from, null, filters.month, filters.year, isClient ? entity.id : null),
        laravelService.getExpenses(from, filters.month, filters.year, isClient ? null : entity.id),
        laravelService.getTaxes(from)
    ]);

    // Build Bot-Side Tax Map
    const taxMap = {};
    if (taxResources && taxResources.tax) {
        taxResources.tax.forEach(t => {
            taxMap[t.id] = parseFloat(t.rate || 0);
        });
    }

    const currency = (invoices[0] || expenses[0] || {}).currency || 'MAD';
    
    // Revenue HT Calculation (from Invoice Articles)
    const revenueStats = invoices.reduce((acc, inv) => {
        const articles = inv.articles || inv.items || inv.invoice_products || [];
        const invHT = articles.reduce((sum, art) => sum + parseFloat(art.total_price_ht || art.price_ht || 0), 0) || parseFloat(inv.amount || 0);
        
        // Ultimate Reporting Consistency: Always re-calculate from articles/rate
        // PRIORITIZE art.tax.rate (Relationship) -> Bot-Side Map -> raw ID fallback
        const invVAT = articles.reduce((sum, art) => {
            const ht = parseFloat(art.total_price_ht || art.price_ht || 0);
            
            let rate = 0;
            if (art.tax && art.tax.rate !== undefined) {
                rate = parseFloat(art.tax.rate);
            } else if (art.tva_percentage && taxMap[art.tva_percentage] !== undefined) {
                rate = taxMap[art.tva_percentage];
            } else {
                rate = parseFloat(art.tva_percentage || art.tax_rate || art.tax_percentage || 0);
            }
            
            return sum + (ht * (rate / 100));
        }, 0) || parseFloat(inv.total_vat_payable || inv.total_tva || inv.tax_amount || 0);

        acc.revenueHT += invHT;
        acc.vatCollected += invVAT;
        if (inv.status === 'ISSUED') acc.outstanding += invHT; 
        return acc;
    }, { revenueHT: 0, vatCollected: 0, outstanding: 0 });

    const expenseStats = expenses.reduce((acc, exp) => {
        acc.totalTTC += parseFloat(exp.total_ttc || exp.amount || 0);
        acc.totalVAT += parseFloat(exp.total_tva || exp.tax_amount || 0);
        return acc;
    }, { totalTTC: 0, totalVAT: 0 });

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
    if (periodStr) report += `📅 *${t('field_period', state.lang)} :* ${periodStr}\n`;
    report += `━━━━━━━━━━━━━━━━━━\n\n`;

    if (isClient) {
      // --- CLIENT VIEW (SALES) ---
      report += `💰 *${t('field_revenue', state.lang)} :* ${revenueStats.revenueHT.toFixed(2)} ${currency}\n`;
      report += `🕒 *${t('field_outstanding', state.lang)} :* ${revenueStats.outstanding.toFixed(2)} ${currency}\n`;
      report += `📦 *${t('field_quotes', state.lang)} :* ${((await laravelService.getAccountStatus(from, filters.month, filters.year, entity.id, state.lang)).total_quote_sum || 0).toFixed(2)} ${currency}\n`;
      report += `🏛️ *${t('field_vat_collected', state.lang)} :* ${revenueStats.vatCollected.toFixed(2)} ${currency}\n`;
    } else {
      // --- SUPPLIER VIEW (PURCHASES) ---
      report += `💸 *${t('report_expenses', state.lang)} :* ${expenseStats.totalTTC.toFixed(2)} ${currency}\n`;
      report += `🏷️ *${t('field_vat_paid', state.lang)} :* ${expenseStats.totalVAT.toFixed(2)} ${currency}\n`;
      report += `📋 *${t('field_records', state.lang)} :* ${expenses.length}\n`;
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

      transactions.forEach((transaction) => {
          let amount = 0;
          if (type === 'inv') {
              amount = (transaction.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
          } else {
              amount = parseFloat(transaction.total_ttc || transaction.ttc || 0);
          }
          totalSum += amount;
          if (transaction.currency) currency = transaction.currency;
      });

      const rows = transactions.slice(0, 10).map((transaction) => {
        const date = transaction.date ? new Date(transaction.date).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB') : 'N/A';
        
        let amount = 0;
        if (type === 'inv') {
          amount = (transaction.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
        } else {
          amount = parseFloat(transaction.total_ttc || transaction.ttc || 0);
        }

        const fmtAmount = new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + (transaction.currency || currency);
        const prefix = type === 'inv' ? 'v_inv_' : 'v_exp_';

        return {
           id: `${prefix}${transaction.id}`,
           title: `${date} — ${fmtAmount}`,
           description: transaction.notes || (type === 'inv' ? t('field_invoice_num', state.lang) + ` Ref: ${transaction.id}` : t('field_expense_num', state.lang) + ` Ref: ${transaction.id}`)
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

      if (document.articles) {
          logger.debug(`🔍 [DOCUMENT MATCHED] Type: ${type}, ID: ${id}`);
      }

      if (!document || !document.download_url) {
        return whatsappService.sendTextMessage(from, t('error_media_delivery', state.lang, { label, id }));
      }

      const date = document.date ? new Date(document.date).toLocaleDateString('en-GB') : 'N/A';
      
      // Fetch tax resources to map ID to rate (Bot-Side API Map)
      const taxResources = await laravelService.getTaxes(from);
      const taxMap = {};
      if (taxResources && taxResources.tax) {
          taxResources.tax.forEach(t => taxMap[t.id] = parseFloat(t.rate || 0));
      }

      // Calculate amount (HT) and VAT from articles
      let amountHT = 0;
      let tvaAmount = 0;
      let tvaRate = 0;

      if (type === 'inv') {
        const articles = document.articles || document.items || document.invoice_products || [];
        amountHT = articles.reduce((sum, art) => sum + parseFloat(art.total_price_ht || art.price_ht || 0), 0) || parseFloat(document.amount || 0);
        
        // Priority 1: Backend Pre-calculated Fields (for Consistency)
        tvaAmount = parseFloat(document.total_vat_payable || document.total_tva || document.total_tax || document.tax_amount || document.tax_price || 0);
        let rawTvaRate = document.tax_rate || document.tva_percentage || document.tax_percentage || 0;
        tvaRate = taxMap[rawTvaRate] !== undefined ? taxMap[rawTvaRate] : parseFloat(rawTvaRate);

        // Priority 2: Manual Math Fallback
        if (tvaAmount === 0 && articles.length > 0) {
            tvaAmount = articles.reduce((sum, art) => {
                const ht = parseFloat(art.total_price_ht || art.price_ht || 0);
                const rawArtRate = parseFloat(art.tva_percentage || art.tax_rate || art.tax_percentage || 0);
                const processedRate = taxMap[rawArtRate] !== undefined ? taxMap[rawArtRate] : rawArtRate;
                
                if (processedRate > 0 && !tvaRate) tvaRate = processedRate; 
                return sum + (ht * (processedRate / 100));
            }, 0);
        }
      } else {
        amountHT = parseFloat(document.net_amount || document.amount || document.total_ttc || 0);
        tvaAmount = parseFloat(document.total_tva || document.tax_amount || 0);
        tvaRate = document.tax_rate || 0;
      }

      const locale = state.lang === 'fr' ? 'fr-FR' : 'en-US';
      const currency = document.currency || 'MAD';
      const fmtHT = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(amountHT) + ' ' + currency;
      const fmtVat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(tvaAmount) + ' ' + currency;
      const entityName = type === 'inv' ? (document.client?.client_name || 'N/A') : (document.supplier?.supplier_name || 'N/A');
      const entityLabelText = type === 'inv' ? t('label_client', state.lang) : t('label_supplier', state.lang);
      const notesText = document.notes || document.description || 'N/A';
      const vatLabel = state.lang === 'fr' ? 'TVA' : 'VAT';

      const successText = `🧾 *${t('media_doc_title', state.lang, { label: label.toUpperCase() })}*\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🏢 *${entityLabelText}:* ${entityName}\n` +
                          `💰 *Total HT:* ${fmtHT}\n` +
                          `📉 *${vatLabel} (${tvaRate}%):* ${fmtVat}\n` +
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
  /**
   * Send VAT selection list (Compulsory Flow)
   */
  async sendVatSelectionList(from) {
    const state = await stateService.getUserState(from);
    const resources = await laravelService.getTaxes(from);
    
    const text = t('prompt_vat_selection', state.lang);

    if (!resources || !resources.tax || resources.tax.length === 0) {
      // Fallback to manual entry if API fails
      await whatsappService.sendTextMessage(from, t('prompt_vat_selection', state.lang) + t('vat_selection_eg', state.lang));
      return;
    }

    const taxes = resources.tax;
    
    // Always show as List for VAT selection
    const rows = taxes.map(t => ({
      id: `set_vat_${t.id}`,
      title: this.localizeTaxName(t.name || `${t.rate}%`, state.lang),
      description: `Rate: ${t.rate}%`
    }));

    await whatsappService.sendInteractiveList(
      from, 
      text, 
      t('list_button_vat', state.lang), 
      [{ title: t('section_available_taxes', state.lang), rows }]
    );
  }

  /**
   * Helper to find a database Tax ID based on a raw percentage rate (e.g. 20)
   * Hardened with Smart Math to detect rates from absolute VAT amounts.
   */
  async resolveTaxFromRate(from, vatValue, totalAmount = 0) {
    try {
        const resources = await laravelService.getTaxes(from);
        if (!resources || !resources.tax) return null;

        const rateInput = parseFloat(vatValue);
        if (isNaN(rateInput)) return null;

        logger.debug(`🔍 [DEBUG] Resolving tax for input: ${rateInput} (Total Amount: ${totalAmount}) among ${resources.tax.length} options`);

        // Phase 1: Direct Match (Treating input as a percentage - e.g., 2)
        // If the number is small (e.g. 2), we strongly suspect it's a rate.
        let match = resources.tax.find(t => Math.abs(parseFloat(t.rate) - rateInput) < 0.01);
        if (match) {
            return {
                id: parseInt(match.id),
                rate: match.rate,
                name: match.name || `${match.rate}%`
            };
        }

        // Phase 2: Back-calculate (Treating input as a total VAT amount - e.g., 200 recorded for 1000)
        if (totalAmount > 0) {
            const calculatedRate = (rateInput / totalAmount) * 100;
            logger.debug(`🔍 [DEBUG] Trying back-calculated rate: ${calculatedRate.toFixed(2)}%`);
            
            match = resources.tax.find(t => Math.abs(parseFloat(t.rate) - calculatedRate) < 0.01);
            if (match) {
                return {
                    id: parseInt(match.id),
                    rate: match.rate,
                    name: match.name || `${match.rate}%`
                };
            }

            // Try alternate math: If totalAmount was TTC (vat included)
            if (totalAmount > rateInput) {
                const altRate = (rateInput / (totalAmount - rateInput)) * 100;
                logger.debug(`🔍 [DEBUG] Trying alternate back-calculated rate (TTC mode): ${altRate.toFixed(2)}%`);
                match = resources.tax.find(t => Math.abs(parseFloat(t.rate) - altRate) < 0.01);
                if (match) {
                    return {
                        id: parseInt(match.id),
                        rate: match.rate,
                        name: match.name || `${match.rate}%`
                    };
                }
            }
        }

        return null;
    } catch (err) {
        logger.error('❌ Error in resolveTaxFromRate:', err);
        return null;
    }
  }

  /**
   * Resolves a text category name to a database ID
   */
  async resolveCategoryFromName(from, categoryName) {
    try {
        const categories = await laravelService.getCategories(from);
        if (!categories || categories.length === 0) return null;

        const sanitize = (val) => val ? String(val).toLowerCase().replace(/[.!]$/, '').trim() : '';
        const searchName = sanitize(categoryName);
        
        // Phase 1: Exact Match
        let match = categories.find(c => sanitize(c.name) === searchName);
        if (match) return match;

        // Phase 2: Partial Match (e.g. "Food" matches "Food & Dining")
        match = categories.find(c => searchName.includes(sanitize(c.name)) || sanitize(c.name).includes(searchName));
        if (match) return match;

        return null;
    } catch (err) {
        logger.error('❌ Error in resolveCategoryFromName:', err);
        return null;
    }
  }

  /**
   * Resolves a text name to a database Product ID
   */
  async resolveProductFromName(from, productName) {
    if (!productName) return null;
    try {
        const products = await laravelService.getProducts(from);
        if (!products || products.length === 0) return null;

        const sanitize = (val) => val ? String(val).toLowerCase().replace(/[.!]$/, '').trim() : '';
        const searchName = sanitize(productName);
        
        // Phase 1: Exact Match
        let match = products.find(p => sanitize(p.name) === searchName);
        if (match) return match;

        // Phase 2: Partial Match
        match = products.find(p => searchName.includes(sanitize(p.name)) || sanitize(p.name).includes(searchName));
        if (match) return match;

        return null;
    } catch (err) {
        logger.error('❌ Error in resolveProductFromName:', err);
        return null;
    }
  }

  async sendProductSelectionList(from, products) {
    const state = await stateService.getUserState(from);
    const body = t('product_select_title', state.lang);
    const rows = (products || []).slice(0, 10).map(p => ({
        id: `inv_p_${p.id}`,
        title: String(p.name).substring(0, 24)
    }));

    if (rows.length === 0) {
        // If no products, we can't force selection - maybe use default 1?
        // But the user said "pure DB thing", so let's keep it empty or show error
        rows.push({ id: 'inv_p_1', title: 'Default Service' });
    }

    await whatsappService.sendInteractiveList(from, body, t('btn_select_product', state.lang), [
        { title: t('products', state.lang), rows }
    ]);
  }

  /**
   * Simple helper to localize Tax names from DB
   */
  localizeTaxName(name, lang) {
    if (lang === 'fr') {
        return name.replace(/VAT/gi, 'TVA');
    }
    return name;
  }
}

const whatsappController = new WhatsAppController();
logger.debug(`🚀 WhatsApp Bot Controller Initialized (Mode: ${laravelService.backendMode.toUpperCase()})`);
logger.debug(`📡 API Base: ${laravelService.baseUrl}`);

module.exports = whatsappController;
