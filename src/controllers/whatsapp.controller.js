const path = require('path');
const whatsappService = require('../services/whatsapp.service');
const aiService = require('../services/ai.service');
const storageService = require('../services/storage.service');
const laravelService = require('../services/laravel.service');
const stateService = require('../services/state.service');
const config = require('../config');
const fs = require('fs');

class WhatsAppController {
  constructor() {
    this.processedMessageIds = new Set();
    // Periodically clear old IDs to prevent memory leak
    setInterval(() => this.processedMessageIds.clear(), 3600000); // Every hour
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
    console.log('📬 NEW WEBHOOK EVENT RECEIVED');
    console.log('📦 BODY:', JSON.stringify(body, null, 2));

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
                console.log(`⚠️ ALREADY PROCESSED MESSAGE: ${message.id}`);
                continue;
              }
              this.processedMessageIds.add(message.id);
              
              this.processMessage(message).catch(err => {
                console.error('❌ BACKGROUND PROCESSING ERROR:', err);
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
      console.log(`🔍 [DEBUG] Incoming message from: "${from}"`);

      // 0. Global Activation Check
      let isAuth = config.bypassAuth === true;
      
      if (!isAuth) {
        isAuth = await laravelService.checkAuth(from);
        console.log(`🔍 [DEBUG] Auth check result for ${from}: ${isAuth}`);
      } else {
        console.log(`📡 [BYPASS] Activation check bypassed for ${from}`);
      }

      if (!isAuth) {
          // If not auth, we only allow getting the welcome message which explains how to activate
          // but we block all other logic.
          await whatsappService.sendTextMessage(from, "🛑 *Activation Required*\n\nYour WhatsApp bot is not yet linked to your accounting dashboard.\n\nTo activate:\n1. Log in to your web portal.\n2. Go to *Settings > WhatsApp Bot*.\n3. Click *Activate Bot*.\n\nOnce activated, you can start recording expenses and invoices here!");
          return;
      }

      const type = message.type;
      const state = stateService.getUserState(from);
      
      let text = '';
      let interactiveId = null;

      // 1. Text/Interactive/Button Handler
      if (type === 'text' || type === 'interactive' || type === 'button') {
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
        console.log(`💬 MESSAGE FROM ${from}: "${text}" (Type: ${type})`);

        // --- GLOBAL INTENT INTERCEPTOR (Allows switching at ANY time) ---
        const primaryIntents = {
            'status': { keywords: ['status', 'dashboard', 'report'], id: 'status' },
            'expense': { keywords: ['expense', 'record expense', 'new expense', 'add expense', 'record voice', 'audio note'], id: 'record_expense' },
            'invoice': { keywords: ['invoice', 'record invoice', 'new invoice', 'add invoice'], id: 'record_invoice' },
            'statement': { keywords: ['statement', 'upload statement', 'bank statement'], id: 'upload_statement' },
            'accountant': { keywords: ['ask accountant', 'contact accountant', 'talk to accountant'], id: 'ask_accountant' },
            'menu': { keywords: ['menu', 'start', 'home', 'main menu', 'exit', 'cancel', 'stop', 'quit'], id: 'menu' }
        };

        let detectedIntent = null;
        for (const [intent, config] of Object.entries(primaryIntents)) {
            if (interactiveId === config.id || 
                config.keywords.some(k => textLower === k || (textLower.length > 5 && textLower.includes(k)))) {
                detectedIntent = intent;
                break;
            }
        }

        if (detectedIntent) {
            console.log(`🎯 DETECTED INTENT: ${detectedIntent} (Current State: ${state.state})`);
            
            // FIX: Prevent recursive prompting loops and allow direct data entry
            // If already in the flow OR if the message follows a data-like pattern (longer than 2 words),
            // skip the re-triggering of prompts and let the parser handle it.
            const isReTrigger = (detectedIntent === 'expense' && state.state === 'AWAITING_EXPENSE_DATA') ||
                                (detectedIntent === 'invoice' && state.state === 'AWAITING_INVOICE_DATA') ||
                                (detectedIntent === 'statement' && state.state === 'AWAITING_STATEMENT_DATA');
            
            const isDirectData = type === 'text' && text.split(' ').length > 2 && (detectedIntent === 'expense' || detectedIntent === 'invoice');

            if ((isReTrigger || isDirectData) && type === 'text') {
                console.log(`♻️ RE-TRIGGER OR DIRECT DATA: Skipping intent reset to allow parsing logic to take over.`);
                // We fall through to the parsing logic below
            } else {
                // If switching to a new major task or triggering via button, clear the old state first
                stateService.clearUserState(from);

                switch (detectedIntent) {
                    case 'menu':
                        await this.sendWelcomeMenu(from);
                        return;
                    case 'status':
                        await whatsappService.sendTextMessage(from, "Retrieving your account status summary...");
                        const stats = await laravelService.getAccountStatus(from);
                        await this.sendStatusInteractive(from, stats);
                        return;
                    case 'expense':
                        stateService.setUserState(from, 'AWAITING_EXPENSE_DATA');
                        await whatsappService.sendTextMessage(from, "Please provide the expense details or upload a receipt photo/audio note.\nExample: '150.00 for office supplies'");
                        return;
                    case 'invoice':
                        stateService.setUserState(from, 'AWAITING_INVOICE_DATA');
                        await whatsappService.sendTextMessage(from, "Please provide the invoice details or upload the document (PDF/Image).\nExample: '500.00 invoice for ABC Consulting'");
                        return;
                    case 'statement':
                        stateService.setUserState(from, 'AWAITING_STATEMENT_DATA');
                        await whatsappService.sendTextMessage(from, "Please upload your Bank Statement in PDF format.");
                        return;
                    case 'accountant':
                        await this.handleAccountantQuery(from);
                        return;
                }
            }
        } else if (state.state === 'IDLE' || text.split(' ').length > 2) {
            // --- AI INTENT FALLBACK (Point #4) ---
            // Only trigger if hard-coded match fails AND user is idle OR sending a sentence
            const aiIntent = await aiService.classifyIntent(text, from);
            if (aiIntent !== 'UNKNOWN' && aiIntent !== 'MENU') {
                console.log(`🤖 AI SWITCH DETECTED: -> ${aiIntent}`);
                stateService.clearUserState(from);
                
                if (aiIntent === 'STATUS') {
                    await whatsappService.sendTextMessage(from, "Retrieving your account status summary (AI detected)...");
                    const stats = await laravelService.getAccountStatus(from);
                    await this.sendStatusInteractive(from, stats);
                    return;
                } else if (aiIntent === 'EXPENSE') {
                    console.log(`🤖 AI SWITCH DETECTED: -> EXPENSE (Data provided in sentence)`);
                    // Fall through to parsing logic below
                } else if (aiIntent === 'INVOICE') {
                    console.log(`🤖 AI SWITCH DETECTED: -> INVOICE (Data provided in sentence)`);
                    // Fall through to parsing logic below
                } else if (aiIntent === 'ACCOUNTANT') {
                    await this.handleAccountantQuery(from);
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
          if (textLower === 'confirm') {
            const result = await laravelService.createExpense(state.data.expenseData, state.data.receiptPath, from);
            let feedback = "*Record Saved Successfully*";
            
            if (state.data.receiptPath) {
              const fileName = path.basename(state.data.receiptPath);
              const isAudio = fileName.endsWith('.ogg');
              
              if (!isAudio) {
                feedback += "\nYour document has been synchronized with the portal.";
                let finalUrl = result.file_url || `${config.botPublicUrl}/storage/${fileName}`;
                feedback += `\n\nView Document: ${finalUrl}`;
              } else {
                feedback += "\nYour voice note has been processed and saved.";
              }
            } else {
              feedback += "\nYour accountant has been notified. You may provide a receipt at a later time.";
            }
            
            await whatsappService.sendTextMessage(from, feedback);
            stateService.clearUserState(from);
          } else if (textLower === 'edit') {
            stateService.setUserState(from, 'AWAITING_EDIT_SELECT', state.data);
            await this.sendEditSelectionButtons(from);
          } else {
            await whatsappService.sendTextMessage(from, "Please select 'Confirm' to save this record or 'Edit' to make changes.\n\nNote: You may also upload a photo now to link it as a receipt.");
          }
          return;
        }

        // --- Handle Invoice Confirmation ---
        if (state.state === 'AWAITING_INVOICE_CONFIRMATION') {
            if (textLower === 'confirm') {
                await laravelService.createInvoice(state.data.invoiceData, state.data.filePath, from);
                await whatsappService.sendTextMessage(from, "Invoice recorded successfully.");
                stateService.clearUserState(from);
                await this.sendWelcomeMenu(from);
            } else if (textLower === 'edit') {
                stateService.setUserState(from, 'AWAITING_EDIT_SELECT_INVOICE', state.data);
                await this.sendEditSelectionButtons(from, 'INVOICE');
            } else {
                await whatsappService.sendTextMessage(from, "Please select 'Confirm' to save this invoice or 'Edit' to make changes.\n\nNote: You may also upload the invoice document now to link it.");
            }
            return;
        }

        // Check for Edit Selection state
        if (state.state === 'AWAITING_EDIT_SELECT' || state.state === 'AWAITING_EDIT_SELECT_INVOICE') {
          const isInvoice = state.state === 'AWAITING_EDIT_SELECT_INVOICE';
          const nextStateSuffix = isInvoice ? '_INVOICE' : '';

          if (interactiveId === 'amt' || textLower === 'amount') {
            stateService.setUserState(from, 'AWAITING_AMOUNT_EDIT' + nextStateSuffix, state.data );
            await whatsappService.sendTextMessage(from, "Please enter the corrected Amount:");
          } else if (interactiveId === 'ent' || textLower === 'entity' || textLower === 'client') {
            if (isInvoice) {
                const clients = await laravelService.getClients(from);
                if (clients && clients.length > 0) {
                    stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', state.data);
                    await this.sendClientSelectionList(from, clients);
                } else {
                    stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', state.data);
                    await whatsappService.sendTextMessage(from, "No existing clients found. Please type the **Name of the Client** for this invoice:");
                }
            } else {
                const suppliers = await laravelService.getSuppliers(from);
                if (suppliers && suppliers.length > 0) {
                    stateService.setUserState(from, 'AWAITING_EXPENSE_ENTITY', state.data);
                    await this.sendSupplierSelectionList(from, suppliers);
                } else {
                    stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', state.data);
                    await whatsappService.sendTextMessage(from, "No existing suppliers found. Please type the **Supplier Name** for this expense:");
                }
            }
          } else if (interactiveId === 'date' || textLower === 'date') {
            stateService.setUserState(from, (isInvoice ? 'AWAITING_DATE_EDIT_INVOICE' : 'AWAITING_DATE_EDIT'), state.data );
            await whatsappService.sendTextMessage(from, "Please enter the corrected Date (YYYY-MM-DD):");
          } else if (interactiveId === 'pay' || textLower === 'payment via') {
            stateService.setUserState(from, (isInvoice ? 'AWAITING_PAYMENT_METHOD_EDIT_INVOICE' : 'AWAITING_PAYMENT_METHOD_EDIT'), state.data );
            await this.sendPaymentMethodSelectionList(from, isInvoice ? 'INVOICE' : 'EXPENSE');
          } else if (interactiveId === 'cat' || textLower === 'category') {
            if (isInvoice) {
                stateService.setUserState(from, 'AWAITING_CATEGORY_EDIT_INVOICE', state.data);
                await whatsappService.sendTextMessage(from, "Please enter the corrected Category:");
            } else {
                const categories = await laravelService.getCategories();
                stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', state.data);
                await this.sendCategorySelectionList(from, categories);
            }
          } else if (interactiveId === 'desc' || textLower === 'description' || textLower === 'notes') {
            stateService.setUserState(from, 'AWAITING_DESCRIPTION_EDIT' + nextStateSuffix, state.data);
            await whatsappService.sendTextMessage(from, isInvoice ? "Please enter the corrected Notes:" : "Please enter the corrected Description:");
          } else if (interactiveId === 'all' || textLower === 're-submit entry') {
            stateService.setUserState(from, 'IDLE');
            await whatsappService.sendTextMessage(from, "Please provide the corrected details:");
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
                await whatsappService.sendTextMessage(from, "Entry updated.");
                await this.sendInvoiceReviewButtons(from, state.data.invoiceData, state.data.filePath);
            } else {
                stateService.setUserState(from, 'AWAITING_EXPENSE_CONFIRMATION', state.data);
                await whatsappService.sendTextMessage(from, "Entry updated.");
                await this.sendExpenseReviewButtons(from, state.data.expenseData, state.data.receiptPath);
            }
            return;
        }

        // --- Handle Statement Month Confirmation ---
        if (state.state === 'AWAITING_STATEMENT_CONFIRMATION') {
            if (interactiveId === 'confirm' || textLower === 'confirm') {
                await whatsappService.sendTextMessage(from, `Uploading statement for ${state.data.monthYear}...`);
                await laravelService.uploadStatement(state.data.filePath, from, state.data.monthYear);
                await whatsappService.sendTextMessage(from, "*Bank statement successfully uploaded to the portal.*");
                stateService.clearUserState(from);
                await this.sendWelcomeMenu(from);
            } else if (interactiveId === 'edit_month' || textLower === 'edit') {
                stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath: state.data.filePath });
                await whatsappService.sendTextMessage(from, "Please specify the correct Month/Year (e.g., April 2026):");
            } else if (interactiveId === 'cancel' || textLower === 'cancel') {
                stateService.clearUserState(from);
                await whatsappService.sendTextMessage(from, "Upload cancelled. Let me know if you need anything else!");
                await this.sendWelcomeMenu(from);
            }
            return;
        }

        // --- Handle Statement Month Selection ---
        if (state.state === 'AWAITING_STATEMENT_MONTH') {
            const monthYear = await aiService.parseStatementMonth(text, from, true);
            
            if (monthYear === 'Unknown') {
                await whatsappService.sendTextMessage(from, "I couldn't identify a valid month for the statement. Please specify the **Month and Year** (e.g., March 2026):");
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
                await whatsappService.sendTextMessage(from, "Please type the **Name of the Client** for this invoice:");
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
        if (state.state === 'AWAITING_NEW_CLIENT_NAME') {
            state.data.invoiceData.client_name = text.trim();
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'text');
        }

        // --- Handle Invoice Payment Method Selection ---
        if (state.state === 'AWAITING_INVOICE_PAYMENT_METHOD') {
            state.data.invoiceData.payment_method = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.invoiceData, state.data.filePath, 'interactive');
        }

        // --- Handle Expense Payment Method Selection ---
        if (state.state === 'AWAITING_EXPENSE_PAYMENT_METHOD') {
            state.data.expenseData.payment_method = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Expense Category Selection ---
        if (state.state === 'AWAITING_EXPENSE_CATEGORY') {
            state.data.expenseData.category = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Expense Supplier Selection ---
        if (state.state === 'AWAITING_EXPENSE_ENTITY') {
            if (interactiveId === 'skip_supplier') {
                stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', state.data);
                await whatsappService.sendTextMessage(from, "Please type the Supplier/Entity name:");
                return;
            }
            state.data.expenseData.entity = interactiveId || text;
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'interactive');
        }

        // --- Handle Expense Amount Input ---
        if (state.state === 'AWAITING_EXPENSE_AMOUNT') {
            const parsed = await aiService.parseExpenseText(text, [], from, true);
            if (parsed.amount > 0) {
                state.data.expenseData.amount = parsed.amount;
                if (parsed.currency) state.data.expenseData.currency = parsed.currency;
            } else {
                // If still no number, assume text is just the number
                const num = parseFloat(text.replace(/[^0-9.]/g, ''));
                if (!isNaN(num) && num > 0) {
                    state.data.expenseData.amount = num;
                }
            }
            return this.handleDocumentRouting(from, state.data.expenseData, state.data.receiptPath, 'text');
        }

        // 1. Text Unified Parsing
        const initialStates = ['AWAITING_EXPENSE_DATA', 'AWAITING_INVOICE_DATA', 'AWAITING_STATEMENT_DATA'];
        const isCommand = initialStates.includes(state.state) || 
                          textLower.startsWith('expense') || 
                          textLower.startsWith('invoice') || 
                          textLower.startsWith('statement') || 
                          text.split(' ').length > 2;

        if (type === 'text' && isCommand) {
            try {
                const categories = await laravelService.getCategories();
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

      // 2. Media Handler (Image, Document, Audio)
      if (type === 'image' || type === 'document' || type === 'audio') {
            const isCapturing = state.state !== 'IDLE';

            // --- SMART AI TRIGGER ---
            const initialStates = ['AWAITING_EXPENSE_DATA', 'AWAITING_INVOICE_DATA', 'AWAITING_STATEMENT_DATA'];
            const needsAI = (type === 'audio') || 
                            !isCapturing || 
                            initialStates.includes(state.state) || 
                            state.state.includes('EDIT') || 
                            state.state.includes('ENTITY') || 
                            state.state.includes('CATEGORY') ||
                            state.state.includes('AMOUNT') ||
                            state.state.includes('DATE');

            if (!isCapturing) {
                await whatsappService.sendTextMessage(from, `Analyzing ${type} attachment...`);
            } else if (needsAI) {
                await whatsappService.sendTextMessage(from, `Processing ${type} to complete your record...`);
            } else {
                await whatsappService.sendTextMessage(from, `Linking ${type} to current record...`);
            }
            
            const mediaId = message[type].id;
            const extension = type === 'image' ? 'jpg' : (type === 'audio' ? 'ogg' : (message.document.filename?.split('.').pop() || 'pdf'));
            const localPath = await storageService.downloadMedia(mediaId, `${type}_${Date.now()}.${extension}`);
            
            const stats = fs.statSync(localPath);
            const fileSizeInMegabytes = stats.size / (1024 * 1024);
            if (fileSizeInMegabytes > 2.0) {
                await whatsappService.sendTextMessage(from, `File exceeds 2MB limit.`);
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                return;
            }

            let data = {};
            const categories = await laravelService.getCategories();

            if (needsAI) {
                try {
                    if (type === 'audio') {
                        const transcription = await aiService.transcribeVoice(localPath, from);
                        const transLower = (transcription || "").toLowerCase().trim();
                        console.log(`🎙️ AUDIO TRANSCRIPTION: "${transLower}"`);

                        // --- VOICE INTERRUPT CHECK (Point #4) ---
                        const voiceIntents = [
                            { intent: 'status', keywords: ['status', 'dashboard', 'report'] },
                            { intent: 'expense', keywords: ['record expense', 'new expense', 'add expense', 'record voice', 'audio note'] },
                            { intent: 'invoice', keywords: ['record invoice', 'new invoice', 'add invoice'] },
                            { intent: 'menu', keywords: ['menu', 'cancel', 'exit', 'main menu'] }
                        ];

                        let voiceIntentMatch = null;
                        for (const v of voiceIntents) {
                            if (v.keywords.some(k => transLower === k || transLower.includes(k))) {
                                voiceIntentMatch = v.intent;
                                break;
                            }
                        }
                        
                        // Extra safety for "status" which is often mis-identified
                        if (!voiceIntentMatch && (transLower === 'status' || transLower === 'status.')) {
                            voiceIntentMatch = 'status';
                        }

                        if (voiceIntentMatch) {
                            console.log(`🎙️ VOICE INTENT DETECTED: ${voiceIntentMatch}`);
                            stateService.clearUserState(from);
                            if (voiceIntentMatch === 'status') {
                                await whatsappService.sendTextMessage(from, "Retrieving your account status summary from voice command...");
                                const stats = await laravelService.getAccountStatus(from);
                                await this.sendStatusInteractive(from, stats);
                                return;
                            } else if (voiceIntentMatch === 'menu') {
                                await this.sendWelcomeMenu(from);
                                return;
                            } else if (voiceIntentMatch === 'expense') {
                                // Logic: If transcription likely contains data, skip the prompt and fall through
                                if (transcription.split(' ').length > 3) {
                                    console.log(`🎙️ VOICE DATA DETECTED (Keyword): Skipping prompt.`);
                                } else {
                                    stateService.setUserState(from, 'AWAITING_EXPENSE_DATA');
                                    await whatsappService.sendTextMessage(from, "Switching to Expense recording. Please provide the details or upload a receipt photo.");
                                    return; // CRITICAL: Stop here for command matching
                                }
                            } else if (voiceIntentMatch === 'invoice') {
                                // Logic: If transcription likely contains data, skip the prompt and fall through
                                if (transcription.split(' ').length > 3) {
                                    console.log(`🎙️ VOICE DATA DETECTED (Keyword): Skipping prompt.`);
                                } else {
                                    stateService.setUserState(from, 'AWAITING_INVOICE_DATA');
                                    await whatsappService.sendTextMessage(from, "Switching to Invoice recording. Please provide the client and amount.");
                                    return; // CRITICAL: Stop here for command matching
                                }
                            }
                        } else {
                            // --- AI VOICE INTENT FALLBACK ---
                            const aiIntent = await aiService.classifyIntent(transcription, from, true);
                            console.log(`🤖 AI VOICE INTENT SENSING: "${transLower}" -> ${aiIntent}`);
                            
                            if (aiIntent !== 'UNKNOWN' && aiIntent !== 'MENU') {
                                console.log(`🤖 AI VOICE SWITCH DETECTED: -> ${aiIntent}`);
                                stateService.clearUserState(from);
                                
                                if (aiIntent === 'STATUS') {
                                    await whatsappService.sendTextMessage(from, "Retrieving your account status summary (Voice AI)...");
                                    const stats = await laravelService.getAccountStatus(from);
                                    await this.sendStatusInteractive(from, stats);
                                    return;
                                } else if (aiIntent === 'EXPENSE') {
                                    console.log(`🤖 AI VOICE DATA DETECTED: Parsing intent.`);
                                    // Fall through to parsing logic
                                } else if (aiIntent === 'INVOICE') {
                                    console.log(`🤖 AI VOICE DATA DETECTED: Parsing intent.`);
                                    // Fall through to parsing logic
                                }
                            } else if (aiIntent === 'UNKNOWN') {
                                console.log(`🛑 AI VOICE NOISE DETECTED: Intent UNKNOWN`);
                                await whatsappService.sendTextMessage(from, "I'm sorry, I couldn't understand the request in your voice note. Could you please repeat it clearly or select an action from the menu?");
                                return; // Stop here!
                            }
                        }

                        data = await aiService.parseExpenseText(transcription, categories, from, true);
                    } else if (type === 'image') {
                        // PIVOT: Following 10-step requirement (Step 7)
                        // File First (IDLE) = Bank Statement.
                        if (!isCapturing) {
                            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath: localPath });
                            await whatsappService.sendTextMessage(from, "Bank Statement detected (Image). 🏦\n\nPlease specify the *Month/Year* for this statement (e.g., April 2026):");
                            return;
                        } else {
                            // Already in a recording flow (e.g. AWAITING_EXPENSE_DATA) - just link as proof
                            const dataKey = state.state.includes('INVOICE') ? 'filePath' : 'receiptPath';
                            const stateData = state.data || {};
                            stateData[dataKey] = localPath;
                            stateService.setUserState(from, state.state, stateData);
                            await whatsappService.sendTextMessage(from, "📸 Image attached as proof for this record.");
                            
                            // Continue logic for current data
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

      // Fallback Menu
      if (type !== 'status' && !interactiveId) {
        await this.sendWelcomeMenu(from);
      }
    } catch (error) {
      console.error('❌ ERROR IN PROCESS MESSAGE:', error);
    }
  }

  /**
   * Centralizes routing for all document types (text or media)
   */
  async handleDocumentRouting(from, data, filePath, type) {
    const currentState = stateService.getUserState(from);
    let mergedData = { 
        payment_method: 'WhatsApp',
        ...data 
    };

    // Smart Merge: Don't let empty data from linked attachments overwrite existing session data
    const isCapturing = currentState && currentState.state !== 'IDLE';
  
    if (isCapturing) {
        const existingData = currentState.data.expenseData || currentState.data.invoiceData || {};
        if (!mergedData.amount && existingData.amount) mergedData.amount = existingData.amount;
        if ((!mergedData.category || mergedData.category === 'General') && existingData.category) mergedData.category = existingData.category;
        if ((!mergedData.entity || mergedData.entity === 'General') && existingData.entity) mergedData.entity = existingData.entity;
        if (!mergedData.client_name && existingData.client_name) mergedData.client_name = existingData.client_name;
        if (!mergedData.date && existingData.date) mergedData.date = existingData.date;
        if ((!mergedData.description || mergedData.description.includes('Attachment') || mergedData.description.includes('Document') || mergedData.description.includes('Pending')) && existingData.description) {
            mergedData.description = existingData.description;
        }
        if (existingData.payment_method) mergedData.payment_method = existingData.payment_method;
        
        // STRICTLY preserve original type during an active session
        if (currentState.state.includes('EXPENSE')) {
            mergedData.documentType = 'EXPENSE';
        } else if (currentState.state.includes('INVOICE')) {
            mergedData.documentType = 'INVOICE';
            if (existingData.client_id) mergedData.client_id = existingData.client_id;
            if (existingData.client_name) mergedData.client_name = existingData.client_name;
        } else if (currentState.state.includes('STATEMENT')) {
            mergedData.documentType = 'STATEMENT';
            if (currentState.data.monthYear) mergedData.monthYear = currentState.data.monthYear;
        }
    }

    // --- RE-REFINED SEQUENCING: Map and Resolve AFTER Merge ---
    
    // AI uses 'entity' but invoices use 'client_name' - unify for routing logic
    if (mergedData.documentType === 'INVOICE' && mergedData.entity && mergedData.entity !== 'General' && !mergedData.client_name) {
        mergedData.client_name = mergedData.entity;
    }

    // --- Automated Name Resolution ---
    if (mergedData.client_name && !mergedData.client_id && mergedData.documentType === 'INVOICE') {
        const clients = await laravelService.getClients(from);
        const match = clients.find(c => 
            (c.company_name && c.company_name.toLowerCase() === mergedData.client_name.toLowerCase()) ||
            (c.client_name && c.client_name.toLowerCase() === mergedData.client_name.toLowerCase())
        );
        if (match) {
            mergedData.client_id = match.id;
            mergedData.client_name = match.company_name || match.client_name;
        }
    } else if (mergedData.entity && mergedData.entity !== 'General' && !mergedData.supplier_id && mergedData.documentType === 'EXPENSE') {
        const suppliers = await laravelService.getSuppliers(from);
        const match = suppliers.find(s => s.name && s.name.toLowerCase() === mergedData.entity.toLowerCase());
        if (match) {
            mergedData.supplier_id = match.id;
            mergedData.entity = match.name;
        }
    }

    if (mergedData.documentType === 'STATEMENT') {
        const monthYear = mergedData.monthYear || (isCapturing && currentState.data?.monthYear);

        if (monthYear && filePath && type !== 'audio') {
            // We have both! Prompt for confirmation instead of auto-uploading
            stateService.setUserState(from, 'AWAITING_STATEMENT_CONFIRMATION', { filePath, monthYear });
            await this.sendStatementReviewButtons(from, monthYear);
        } else if (monthYear) {
            // We have the month, but no file yet
            stateService.setUserState(from, 'AWAITING_STATEMENT_FILE', { monthYear });
            await whatsappService.sendTextMessage(from, `Got it. Statement for ${monthYear}.\n\n📎 Please upload the PDF or Image of the statement to complete the record.`);
        } else {
            // We have neither, or just the file but no month
            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath });
            await whatsappService.sendTextMessage(from, "Bank Statement detected.\n\nPlease specify the Month/Year for this statement (e.g., March 2026).");
        }
    } else if (mergedData.documentType === 'INVOICE') {
        const inv = mergedData;
        const invalidValues = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined'];
        
        // 1. Date Check: Only ask if missing
        if (!inv.date) {
            stateService.setUserState(from, 'AWAITING_INVOICE_DATE', { filePath, invoiceData: inv });
            await whatsappService.sendTextMessage(from, "Invoice detected. Please provide the Invoice Date (e.g., 2026-04-02):");
            return;
        } 
        
        // 2. Client Check: Ask if ID missing AND Name is invalid/placeholder
        const isNameInvalid = !inv.client_name || invalidValues.includes(inv.client_name.toLowerCase());
        if (!inv.client_id && isNameInvalid) {
            const clients = await laravelService.getClients(from);
            if (clients && clients.length > 0) {
                stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', { filePath, invoiceData: inv });
                await this.sendClientSelectionList(from, clients);
            } else {
                stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', { filePath, invoiceData: inv });
                await whatsappService.sendTextMessage(from, "The AI couldn't identify the client. Please type the **Name of the Client** for this invoice:");
            }
            return;
        }

        // 3. Payment Method Check
        if (!inv.payment_method || invalidValues.includes(inv.payment_method.toLowerCase()) || inv.payment_method.toLowerCase() === 'whatsapp') {
            stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', { filePath, invoiceData: inv });
            await this.sendPaymentMethodSelectionList(from, 'INVOICE');
            return;
        }

        // 4. All Clear! Show Review
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
                await whatsappService.sendTextMessage(from, "Please provide the **Amount** for this expense (e.g. '150 USD' or just '150'):");
                return;
            }

            if (!mergedData.category || invalidValues.includes(mergedData.category.toLowerCase())) {
                const categories = await laravelService.getCategories();
                stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', { expenseData: mergedData, receiptPath: filePath });
                await this.sendCategorySelectionList(from, categories);
            } else if (!mergedData.entity || invalidValues.includes(mergedData.entity.toLowerCase())) {
                const suppliers = await laravelService.getSuppliers(from);
                if (suppliers && suppliers.length > 0) {
                    stateService.setUserState(from, 'AWAITING_EXPENSE_ENTITY', { expenseData: mergedData, receiptPath: filePath });
                    await this.sendSupplierSelectionList(from, suppliers);
                } else {
                    // No suppliers found, ask to type it or skip
                    stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', { expenseData: mergedData, receiptPath: filePath });
                    await whatsappService.sendTextMessage(from, "The AI couldn't identify the supplier. Please type the Supplier/Entity name (or type 'General' to skip):");
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

  async sendWelcomeMenu(from) {
    const body = `*Accounting Assistant Management Portal*\n\nPlease select an action below to manage your bookkeeping:`;
    const sections = [
      {
        title: "Primary Actions",
        rows: [
          { id: 'status', title: 'Account Status', description: 'Monthly financial summary' },
          { id: 'record', title: 'Record Expense', description: 'Submit an expense or receipt' },
          { id: 'inv', title: 'Record Invoice', description: 'Submit a sales invoice' },
          { id: 'stmt', title: 'Upload Statement', description: 'Upload bank statement (PDF)' }
        ]
      }
    ];
    return whatsappService.sendInteractiveList(from, body, "Menu Actions", sections);
  }

  async sendStatusInteractive(from, stats) {
    const income = stats.salesSum || 0;
    const expenses = stats.expensesSum || 0;
    const balance = income - expenses;
    const vat = stats.vatPayable || 0;
    
    let statusIcon = '⚪';
    let statusText = 'No activity recorded yet';
    
    if (stats.invoicesCount > 0) {
        if (stats.pendingReviewCount > 0) {
            statusIcon = '🟡';
            statusText = 'Pending Review (Check portal)';
        } else if (stats.statementsCount > 0) {
            statusIcon = '🟢';
            statusText = 'Accounts Validated';
        } else {
            statusIcon = '🟠';
            statusText = 'Missing Documents (Action Required)';
        }
    } else if (stats.statementsCount > 0) {
        statusIcon = '🟠';
        statusText = 'Invoices Missing (Action Required)';
    }

    const missing = [];
    if (!stats.statementsCount) missing.push('Bank Statement');
    if (stats.invoicesCount === 0) missing.push('Invoices');
    const missingText = missing.length > 0 
        ? `⚠️ *Missing:* ${missing.join(', ')}\n_(Please upload these to the portal or send them here)_` 
        : (statusIcon === '🟢' 
            ? '✅ *All required documents received for this month.*'
            : (stats.monthStatus === 'MISSING_DOCUMENTS' 
                ? `🟠 *Note:* Some transaction receipts or missing details still need your attention in the portal.`
                : '✅ *All required documents received for this month.*'));

    // Currency formatting (basic placeholder for now, could be dynamic)
    const fmt = (num) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(num);

    let body = `📊 *Financial Summary:* ${stats.month}\n` +
               `━━━━━━━━━━━━━━━━━━\n\n` +
               `💶 *BUSINESS PERFORMANCE*\n` +
               `* Total Income:   ${fmt(income)}\n` +
               `* Total Expenses: ${fmt(expenses)}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🏦 *NET BALANCE:  ${fmt(balance)}*\n\n` +
               `📋 *TAX & VAT ESTIMATE*\n` +
               `* VAT Payable:    ${fmt(vat)}\n\n` +
               `📈 *BOOKKEEPING PROGRESS*\n` +
               `* Status: ${statusIcon} ${statusText}\n` +
               `* Invoices recorded: ${stats.invoicesCount}\n` +
               `* Expenses recorded: ${stats.expensesCount}\n` +
               `* Bank Statements:  ${stats.statementsCount}\n\n` +
               `${missingText}\n\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `Select an action below to manage your records:`;
               
    const buttons = [
      { id: 'record', title: 'Record Expense' },
      { id: 'inv', title: 'Record Invoice' },
      { id: 'menu', title: 'Main Menu' }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendExpenseReviewButtons(from, expenseData, receiptPath = null) {
    const path = require('path');
    const invalidNotes = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined', 'processed via ai'];
    let notes = expenseData.description || '';
    if (!notes || invalidNotes.includes(notes.toLowerCase())) {
        notes = 'Professional Services';
    }

    let body = `Reviewing Draft Entry:\n` +
      `Amount: ${expenseData.amount} ${expenseData.currency || 'USD'}\n` +
      `Date: ${expenseData.date || 'Not provided'}\n` +
      `Supplier: ${expenseData.entity || 'General'}\n` +
      `Category: ${expenseData.category || 'General'}\n` +
      `Payment Via: ${expenseData.payment_method || 'WhatsApp'}\n` +
      `Notes: ${notes}\n\n`;

    if (receiptPath) {
      const fileName = path.basename(receiptPath);
      const isAudio = fileName.endsWith('.ogg');
      
      if (!isAudio) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `Receipt Image: Attached\nPreview: ${previewUrl}\n\nPlease confirm to save this entry.`;
      } else {
        body += `Please confirm the details extracted from your voice note to save this entry.`;
      }
    } else {
      body += `You may upload a photo of the receipt now to link it, or confirm to save as text-only.`;
    }
    
    const buttons = [
      { id: 'confirm', title: 'Confirm' },
      { id: 'edit', title: 'Edit' }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendInvoiceReviewButtons(from, invoiceData, filePath = null) {
    const path = require('path');
    const invalidNotes = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined', 'processed via ai'];
    let notes = invoiceData.description || '';
    if (!notes || invalidNotes.includes(notes.toLowerCase())) {
        notes = 'Invoice for services rendered';
    }

    let body = `Reviewing Draft Invoice:\n` +
      `Amount: ${invoiceData.amount} ${invoiceData.currency || 'USD'}\n` +
      `Date: ${invoiceData.date || 'Not provided'}\n` +
      `Client: ${invoiceData.client_name || 'General'}\n` +
      `Payment Via: ${invoiceData.payment_method || 'WhatsApp'}\n` +
      `Notes: ${notes}\n\n`;

    if (filePath) {
      const fileName = path.basename(filePath);
      const isAudio = fileName.endsWith('.ogg');
      
      if (!isAudio) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `Invoice Document: Attached\nPreview: ${previewUrl}\n\nPlease confirm to save this entry.`;
      } else {
        body += `Please confirm the details extracted from your voice note to save this entry.`;
      }
    } else {
      body += `You may upload the invoice document (PDF/Image) now to link it, or confirm to save as text-only.`;
    }
    
    const buttons = [
      { id: 'confirm', title: 'Confirm' },
      { id: 'edit', title: 'Edit' }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendStatementReviewButtons(from, monthYear) {
    const buttons = [
      { id: 'confirm', title: 'Confirm' },
      { id: 'edit_month', title: 'Edit Month' },
      { id: 'cancel', title: 'Cancel' }
    ];

    await whatsappService.sendInteractiveButtons(from, 
      `🏦 *Bank Statement Review*\n\n` +
      `Detected Month: *${monthYear}*\n\n` +
      `Please confirm if you want to upload this document for the specified month.`, 
      buttons
    );
  }

  async sendEditSelectionButtons(from, type = 'EXPENSE') {
    const body = `Select the field you wish to modify:`;
    let rows = [
      { id: 'amt', title: 'Amount' },
      { id: 'date', title: 'Date' },
      { id: 'ent', title: type === 'INVOICE' ? 'Client' : 'Entity' },
      { id: 'pay', title: 'Payment Via' }
    ];

    if (type !== 'INVOICE') {
      rows.splice(3, 0, { id: 'cat', title: 'Category' });
    }

    rows.push({ id: 'desc', title: type === 'INVOICE' ? 'Notes' : 'Description' });
    rows.push({ id: 'all', title: 'Re-submit Entry' });
    
    const sections = [{ title: "Modification Options", rows }];
    return whatsappService.sendInteractiveList(from, body, "Options", sections);
  }

  async sendPaymentMethodSelectionList(from, type = 'INVOICE') {
    const body = `Please select the Payment Via for this ${type.toLowerCase()}:`;
    const rows = [
       { id: 'Bank Transfer', title: 'Bank Transfer' },
       { id: 'Cash', title: 'Cash' },
       { id: 'Credit Card', title: 'Credit Card' },
       { id: 'PayPal', title: 'PayPal' },
       { id: 'Other', title: 'Other' }
    ];
    const sections = [{ title: "Payment Methods", rows }];
    return whatsappService.sendInteractiveList(from, body, "Payment Via", sections);
  }

  async sendClientSelectionList(from, clients) {
    const body = `Please select the Client for this invoice:`;
    const rows = clients.slice(0, 9).map(client => ({
        id: `${client.id}`,
        title: (client.company_name || client.client_name).substring(0, 24),
        description: `Customer ID: ${client.id}`
    }));

    rows.push({ id: 'skip_client', title: 'Other / New Client', description: 'Type the name manually' });

    const sections = [{ title: "Registered Clients", rows }];
    return whatsappService.sendInteractiveList(from, body, "Client List", sections);
  }

  async sendCategorySelectionList(from, categories) {
    const body = `Please select the Category for this expense:`;
    const rows = categories.slice(0, 10).map(cat => ({
        id: (cat.name || cat).substring(0, 200),
        title: (cat.name || cat).substring(0, 24)
    }));

    const sections = [{ title: "Available Categories", rows }];
    return whatsappService.sendInteractiveList(from, body, "Category List", sections);
  }

  async sendSupplierSelectionList(from, suppliers) {
    const body = `Please select the Supplier/Entity for this expense:`;
    const rows = suppliers.slice(0, 9).map(s => ({
        id: s.name,
        title: s.name.substring(0, 24),
        description: `ID: ${s.id}`
    }));
    
    rows.push({ id: 'skip_supplier', title: 'Other / New Supplier', description: 'Type the name manually' });

    const sections = [{ title: "Your Suppliers", rows }];
    return whatsappService.sendInteractiveList(from, body, "Supplier List", sections);
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
}

module.exports = new WhatsAppController();
