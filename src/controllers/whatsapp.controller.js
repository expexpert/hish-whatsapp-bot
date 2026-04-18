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
    this.userQueues = new Map(); // Per-user message queue
    // Periodically clear old IDs to prevent memory leak
    setInterval(() => this.processedMessageIds.clear(), 3600000); // Every hour
  }

  // Persistent Debug Logger
  logDebug(message, data = null) {
      const timestamp = new Date().toISOString();
      let logLine = `[${timestamp}] ${message}\n`;
      if (data) logLine += `DATA: ${JSON.stringify(data, null, 2)}\n`;
      logLine += `-------------------------------------------\n`;
      try {
          fs.appendFileSync(path.join(process.cwd(), 'debug_trace.log'), logLine);
      } catch (err) {
          console.error('Failed to write to debug_trace.log', err);
      }
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
      console.log(`🔍 [DEBUG] Incoming message from: "${from}"`);

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
              console.log(`📢 Sending activation warning to ${from} (Cooldown passed)`);
              await whatsappService.sendTextMessage(from, "🛑 *Activation Required*\n\nYour WhatsApp bot is not yet linked to your accounting dashboard.\n\nTo activate:\n1. Log in to your web portal.\n2. Go to *Settings > WhatsApp Bot*.\n3. Click *Activate Bot*.\n\nOnce activated, you can start recording expenses and invoices here!");
              stateService.setLastWarned(from, now);
          } else {
              console.log(`🔇 Skipping activation warning for ${from} (Cooldown active)`);
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
          const transcription = await aiService.transcribeVoice(audioPath, from);
          
          if (transcription) {
            text = transcription.trim();
            console.log(`🎙️ AUDIO TRANSCRIPTION: "${text}"`);
            
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
        
        // --- GLOBAL INTENT INTERCEPTOR (Allows switching at ANY time) ---
        const primaryIntents = {
            'status': { keywords: ['status', 'dashboard', 'summary'], id: 'status' },
            'expense': { keywords: ['expense', 'record expense', 'new expense', 'add expense', 'record voice', 'audio note'], id: 'record_expense' },
            'invoice': { keywords: ['invoice', 'record invoice', 'new invoice', 'add invoice'], id: 'record_invoice' },
            'statement': { keywords: ['statement', 'upload statement', 'bank statement'], id: 'upload_statement' },
            'reports_menu': { keywords: ['reports', 'quick reports'], id: 'quick_reports' },
            'report': { keywords: ['report', 'how much', 'total', 'summary', 'show me'], id: 'report' },
            'accountant': { keywords: ['ask accountant', 'contact accountant', 'talk to accountant'], id: 'ask_accountant' },
            'menu': { keywords: ['menu', 'start', 'home', 'main menu', 'exit', 'cancel', 'stop', 'quit'], id: 'menu' }
        };

        let detectedIntent = null;
        const isShortMessage = text.split(' ').length <= 2;

        // Force priority for exact menu button interactions to avoid NLP regex conflicts
        if (interactiveId === 'quick_reports') {
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

        // --- NEW: AI INTENT SENSING FOR UNHANDLED TEXT ---
        if (!detectedIntent && (type === 'text' || type === 'audio') && state.state === 'IDLE') {
            const greetings = ['hi', 'hello', 'hey', 'bonjour', 'salam', 'ola'];
            if (!greetings.includes(textLower)) {
                const aiIntent = await aiService.classifyIntent(text, from, true);
                if (aiIntent === 'UNKNOWN') {
                    console.log(`🛑 UNRECOGNIZED TEXT DETECTED: "${text}"`);
                    await whatsappService.sendTextMessage(from, "I'm sorry, I couldn't understand that request. Could you please specify if you want to record an expense, invoice, or check your status?");
                    await this.sendWelcomeMenu(from);
                    return;
                } else if (aiIntent !== 'MENU') {
                    detectedIntent = aiIntent.toLowerCase();
                    console.log(`🤖 AI SENSING OVERRIDE: -> ${detectedIntent}`);
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
                await whatsappService.sendTextMessage(from, `✍️ *Recording expense for ${entityName}*...\n\nPlease provide the details (e.g., '150.00 for office supplies') or upload a receipt photo.`);
            } else {
                stateService.setUserState(from, 'AWAITING_INVOICE_DATA', { 
                    invoiceData: { client_name: entityName, client_id: entityId } 
                });
                await whatsappService.sendTextMessage(from, `✍️ *Recording invoice for ${entityName}*...\n\nPlease provide the details (e.g., '500.00 for consulting services') or upload the document.`);
            }
            return;
        }

        if (detectedIntent) {
            console.log(`🎯 DETECTED INTENT: ${detectedIntent} (Current State: ${state.state})`);
            
            // FIX: Prevent recursive prompting loops and allow direct data entry
            // If already in the flow OR if the message follows a data-like pattern (longer than 2 words),
            // skip the re-triggering of prompts and let the parser handle it.
            const isReTrigger = (detectedIntent === 'expense' && state.state === 'AWAITING_EXPENSE_DATA') ||
                                (detectedIntent === 'invoice' && state.state === 'AWAITING_INVOICE_DATA') ||
                                (detectedIntent === 'statement' && state.state === 'AWAITING_STATEMENT_DATA');
            
            const isDirectData = (type === 'text' || type === 'audio') && text.split(' ').length > 2 && (detectedIntent === 'expense' || detectedIntent === 'invoice');

            if ((isReTrigger || isDirectData) && (type === 'text' || type === 'audio' || type === 'voice')) {
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
                        if (type === 'text' || type === 'audio') {
                            return this.handleReportQuery(from, text);
                        }
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
                    case 'reports_menu':
                        await this.sendReportMenu(from);
                        return;
                    case 'report':
                        await this.handleReportQuery(from, text);
                        return;
                }
            }
        } else if (state.state === 'IDLE' || text.split(' ').length > 2) {
            // --- AI INTENT FALLBACK (Point #4) ---
            // Only trigger if hard-coded match fails AND user is idle OR sending a sentence
            const aiIntent = await aiService.classifyIntent(text, from, true);
            if (aiIntent !== 'UNKNOWN' && aiIntent !== 'MENU') {
                console.log(`🤖 AI SWITCH DETECTED: -> ${aiIntent}`);
                
        // --- STATE PROTECTION: Do not clear if we are ALREADY in the same flow ---
        const isMatchingFlow = (aiIntent === 'EXPENSE' && state.state.includes('EXPENSE')) ||
                               (aiIntent === 'INVOICE' && state.state.includes('INVOICE')) ||
                               (aiIntent === 'STATEMENT' && state.state.includes('STATEMENT'));
        
        if (!isMatchingFlow) {
          stateService.clearUserState(from);
        } else {
          console.log(`🛡️ Persisting current context: Detected ${aiIntent} intent matches active ${state.state} flow.`);
        }
                
                if (aiIntent === 'STATUS') {
                    console.log(`🤖 AI STATUS INTENT detected: routing to handleReportQuery`);
                    return this.handleReportQuery(from, text);
                } else if (aiIntent === 'EXPENSE') {
                    console.log(`🤖 AI SWITCH DETECTED: -> EXPENSE (Data provided in sentence)`);
                    // Fall through to parsing logic below
                } else if (aiIntent === 'INVOICE') {
                    console.log(`🤖 AI SWITCH DETECTED: -> INVOICE (Data provided in sentence)`);
                    // Fall through to parsing logic below
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
          if (textLower === 'confirm') {
            const result = await laravelService.createExpense(state.data.expenseData, state.data.receiptPath, from);
            let feedback = "*Record Saved Successfully*";
            
            if (state.data.receiptPath) {
              const fileName = path.basename(state.data.receiptPath);
              const isAudio = fileName.endsWith('.ogg');
              
              if (!isAudio) {
                feedback += "\nYour document has been synchronized with the portal.";
                
                // Use signed URL if available, else fallback safely
                if (result.data && (result.data.download_url || result.data.id)) {
                  const downloadUrl = result.data.download_url || `${laravelService.publicUrl}/api/bot/file/${result.data.id}`;
                  
                  if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                    console.warn(`⚠️ [WARNING] Sending localhost URL to Meta (Expense): ${downloadUrl}`);
                  }
                  console.log(`💸 [INFO] Delivering Expense Receipt: ${downloadUrl}`);

                  feedback += `\n\n---
📥 *OPEN RECEIPT*
${downloadUrl}`;
                  
                  // Also send as a proper Document Attachment for better UX
                  await whatsappService.sendDocument(from, downloadUrl, `Receipt_${result.data.id || 'Draft'}.pdf`);
                } else {
                  let finalUrl = result.file_url || `${config.botPublicUrl}/storage/${fileName}`;
                  feedback += `\n\n---
📸 *VIEW ATTACHMENT*
${finalUrl}`;
                }
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
        
        if (state.state === 'AWAITING_REPORT_SEARCH' && (isInteractive || !detectedIntent)) {
            return this.handleReportQuery(from, text);
        }

        if (state.state === 'AWAITING_REPORT_PERIOD' && (isInteractive || !detectedIntent)) {
            const period = interactiveId || textLower;
            console.log(`⏳ Processing Report Period: "${period}" for Client/Supp ID: ${state.data?.entityId}`);
            
            // Handle Custom Search Transition
            if (period === 'rep_period_custom') {
                stateService.setUserState(from, 'AWAITING_REPORT_CUSTOM_PERIOD', state.data);
                return whatsappService.sendTextMessage(from, "Sure! Please type the *Month and Year* you want to see (e.g., 'March 2024' or 'Jan 23').");
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
                await whatsappService.sendTextMessage(from, "❌ I'm sorry, I lost track of who you selected. Please try searching again.");
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
                await whatsappService.sendTextMessage(from, "I couldn't quite understand that date. Please try typing something like 'March 2024' or 'February'.\n\n_Type 'cancel' to stop._");
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
            if (textLower === 'confirm') {
                this.logDebug('🚀 INVOICE CONFIRMATION START', { invoiceData: state.data.invoiceData });
                
                const result = await laravelService.createInvoice(state.data.invoiceData, state.data.filePath, from);
                this.logDebug('🧾 LARAVEL RESPONSE RECEIVED', result);
                
                // Laravel returns the signed URL in 'download_url'
                if (result.data && (result.data.download_url || result.data.pdf_url || result.data.id)) {
                    let downloadUrl = result.data.download_url || result.data.pdf_url || `${laravelService.publicUrl}/api/bot/invoice/pdf/${result.data.id}`;
                    
                    this.logDebug('🔗 GENERATED DOWNLOAD URL', { downloadUrl });

                    // Defensive: Ensure we are not sending a localhost URL to Meta
                    if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                        this.logDebug('⚠️ WARNING: Localhost URL detected');
                    }
                    
                    // 1. Deliver the document with a rich Professional Caption
                    try {
                        const date = result.data.date ? new Date(result.data.date).toLocaleDateString('en-GB') : 'N/A';
                        const amount = parseFloat(result.data.total_ttc || result.data.amount || 0);
                        const currency = result.data.currency || 'MAD';
                        const fmtAmount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + currency;
                        const entityName = result.data.client_name || result.data.entity || 'N/A';

                        const successText = `🧾 *INVOICE RECORDED*\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `🏢 *Client:* ${entityName}\n` +
                                            `💰 *Amount:* ${fmtAmount}\n` +
                                            `📅 *Date:* ${date}\n` +
                                            `📝 *Notes:* ${result.data.description || 'N/A'}\n` +
                                            `━━━━━━━━━━━━━━━━━━\n` +
                                            `✅ *Status:* Recorded Successfully`;

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
                            // Otherwise send as document (PDF) with caption
                            waResult = await whatsappService.sendDocument(from, downloadUrl, `Invoice_${result.data.id || 'Draft'}.pdf`, successText);
                        }
                        this.logDebug('✅ WHATSAPP MEDIA SENT', waResult);
                    } catch (waErr) {
                        this.logDebug('❌ WHATSAPP DELIVERY FAILED', waErr.message);
                        // Fallback only if media fails
                        await whatsappService.sendTextMessage(from, "✅ *Invoice Recorded Successfully*");
                    }
                } else {
                    this.logDebug('⚠️ WARNING: No valid ID or URL in response');
                    await whatsappService.sendTextMessage(from, "✅ *Invoice Recorded Successfully*");
                }
                
                // 2. Clear state and show menu
                // We use a longer delay (2.5s) to ensure the PDF arrives before the menu
                stateService.clearUserState(from);
                await new Promise(resolve => setTimeout(resolve, 2500)); 
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
                const categories = await laravelService.getCategories(from);
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
                const result = await laravelService.uploadStatement(state.data.filePath, from, state.data.monthYear);
                
                let feedback = "*Bank statement successfully uploaded to the portal.*";
                if (result.data && (result.data.download_url || result.data.id)) {
                    const downloadUrl = result.data.download_url || `${laravelService.publicUrl}/api/bot/file/${result.data.id}`;
                    
                    if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
                        console.warn(`⚠️ [WARNING] Sending localhost URL to Meta (Statement): ${downloadUrl}`);
                    }
                    console.log(`📄 [INFO] Delivering Bank Statement: ${downloadUrl}`);

                    feedback += `\n\n---
📥 *OPEN STATEMENT*
${downloadUrl}`;
                    
                    // Also send as a proper Document Attachment
                    await whatsappService.sendDocument(from, downloadUrl, `Statement_${state.data.monthYear.replace(' ', '_')}.pdf`);
                }

                await whatsappService.sendTextMessage(from, feedback);
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
        if (state.state === 'AWAITING_NEW_CLIENT_NAME' && !detectedIntent) {
            if (!interactiveId) { // Only validate if it's raw text
                const isValid = await aiService.validateFieldAI(text, 'ENTITY', from, true);
                if (!isValid) {
                    await whatsappService.sendTextMessage(from, "I'm sorry, that doesn't look like a valid client name. 🏢\n\nPlease type the **Name of the Client** for this invoice:");
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
                await whatsappService.sendTextMessage(from, "Please type the **Category Name** for this expense:");
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
                await whatsappService.sendTextMessage(from, "Please type the Supplier name:");
                return;
            }
            
            // Validate Name - Bypass AI if it was an interactive selection from our list
            if (!interactiveId) { 
                const isValid = await aiService.validateFieldAI(text, 'ENTITY', from, true);
                if (!isValid) {
                    await whatsappService.sendTextMessage(from, "I'm sorry, that doesn't look like a valid supplier name. 🏢\n\nPlease type the **Supplier Name** for this expense:");
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
                await whatsappService.sendTextMessage(from, "I'm sorry, I couldn't find a valid amount in your message. 🔢\n\nPlease provide the **Amount** (e.g., '50.00'):");
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
                await whatsappService.sendTextMessage(from, `Analyzing ${type} attachment...`);
            } else if (needsAI) {
                await whatsappService.sendTextMessage(from, `Processing ${type} to complete your record...`);
            } else {
                await whatsappService.sendTextMessage(from, `Linking ${type} to current record...`);
            }
            
            const mediaId = message[type].id;
            const extension = type === 'image' ? 'jpg' : (message.document.filename?.split('.').pop() || 'pdf');
            const localPath = await storageService.downloadMedia(mediaId, `${type}_${Date.now()}.${extension}`);
            
            const stats = fs.statSync(localPath);
            const fileSizeInMegabytes = stats.size / (1024 * 1024);
            if (fileSizeInMegabytes > 2.0) {
                await whatsappService.sendTextMessage(from, `File exceeds 2MB limit.`);
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
                            await whatsappService.sendTextMessage(from, "Bank Statement detected (Image). 🏦\n\nPlease specify the *Month/Year* for this statement (e.g., April 2026):");
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
            const flowName = state.state.includes('INVOICE') ? 'invoice' : (state.state.includes('STATEMENT') ? 'statement' : 'expense');
            await whatsappService.sendTextMessage(from, `🤔 I'm sorry, I didn't quite get that for your ${flowName}. \n\nPlease provide the details or type 'menu' to cancel.`);
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
    console.log(`[DEBUG] ROUTING START - State: ${currentState?.state}`);
    const existingData = (currentState && currentState.data) ? (currentState.data.expenseData || currentState.data.invoiceData || {}) : {};
    console.log(`[DEBUG] Existing Data:`, JSON.stringify(existingData));
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
console.log(data,  "kjlkjlkjlkjlkjlkj")
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
            console.log(mergedData, "mergedDatamergedData")
            const newEntityName = mergedData.entity;
            const isEntityValid = newEntityName && !invalidVals.includes(newEntityName.toLowerCase());

            if (isEntityValid && existingData.supplier_id && existingData.entity && existingData.entity.toLowerCase() !== newEntityName.toLowerCase()) {
                // Check if the NEW name is actually another known supplier
                const suppliers = await fetchSuppliers();
                const searchName = newEntityName.toLowerCase().replace(/[.!]$/, '').trim();
                const isAnotherKnownSupplier = suppliers.some(s => s.name && s.name.toLowerCase().replace(/[.!]$/, '').trim() === searchName);
                
                if (isAnotherKnownSupplier) {
                    console.log(`[DEBUG] Detected context switch to another known supplier: ${newEntityName}`);
                    mergedData.supplier_id = null;
                } else {
                    console.log(`[DEBUG] Potential noise detected: "${newEntityName}". Restoring context: ${existingData.entity}`);
                    mergedData.supplier_id = existingData.supplier_id;
                    mergedData.entity = existingData.entity;
                }
            } else if (existingData.supplier_id && (!mergedData.entity || invalidVals.includes(mergedData.entity.toLowerCase()))) {
                console.log(`[DEBUG] Missing/Invalid entity from AI. Restoring context: ${existingData.entity}`);
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
            await whatsappService.sendTextMessage(from, `Got it. Statement for ${monthYear}.\n\n📎 Please upload the PDF or Image of the statement to complete the record.`);
        } else {
            stateService.setUserState(from, 'AWAITING_STATEMENT_MONTH', { filePath });
            await whatsappService.sendTextMessage(from, "Bank Statement detected.\n\nPlease specify the Month/Year for this statement (e.g., March 2026).");
        }
    } else if (mergedData.documentType === 'INVOICE') {
        const inv = mergedData;
        const invalidValues = ['unknown', 'general', 'n/a', 'none', 'null', 'undefined'];
        
        // --- VALIDATION GUARD: Ensure we have at least an amount or a visual file ---
        // If it's a voice note (audio), we REQUIRE an amount to be extracted before proceeding.
        const isAudio = filePath && filePath.endsWith('.ogg');
        if (!inv.amount && (!filePath || isAudio)) {
            const source = isAudio ? "in that voice note" : "in your message";
            await whatsappService.sendTextMessage(from, `🤔 I couldn't find an amount or valid details ${source}. \n\nPlease provide the invoice details (e.g. '500.00 from ABC') or upload the document.`);
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
            await whatsappService.sendTextMessage(from, "Invoice detected. Please provide the Invoice Date (e.g., 2026-04-02):");
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
                await whatsappService.sendTextMessage(from, "Please provide the **Amount** for this expense (e.g. '150 USD' or just '150'):");
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
                    await whatsappService.sendTextMessage(from, "The AI couldn't identify the supplier. Please type the Supplier name (or type 'General' to skip):");
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
      const [clients, suppliers] = await Promise.all([
          laravelService.getClients(from),
          laravelService.getSuppliers(from)
      ]);
      const body = `📊 *Select a Report*\n\nTap a category or name below to view the financial breakdown:`;
      const rowsGeneral = [
          { id: 'rep_gen_unpaid', title: 'Unpaid Invoices' },
          { id: 'rep_gen_month', title: 'Monthly Summary' },
          { id: 'rep_gen_search', title: 'Search by Name' }
      ];
      const rowsClients = (clients || []).slice(0, 3).map(c => ({
          id: `rep_c_${c.id}`,
          title: (c.company_name || c.client_name).substring(0, 24)
      }));
      const rowsSuppliers = (suppliers || []).slice(0, 3).map(s => ({
          id: `rep_s_${s.id}`,
          title: s.name.substring(0, 24)
      }));
      
      const sections = [{ title: "General Reports", rows: rowsGeneral }];
      if (rowsClients.length > 0) sections.push({ title: "Recent Clients", rows: rowsClients });
      if (rowsSuppliers.length > 0) sections.push({ title: "Recent Suppliers", rows: rowsSuppliers });
      
      return whatsappService.sendInteractiveList(from, body, "Options", sections);
  }

  async handleReportMenuSelection(from, interactiveId) {
      if (interactiveId === 'rep_gen_month') {
          await whatsappService.sendTextMessage(from, "Retrieving your account status summary...");
          const stats = await laravelService.getAccountStatus(from);
          await this.sendStatusInteractive(from, stats);
      } else if (interactiveId === 'rep_gen_unpaid') {
          const stats = await laravelService.getAccountStatus(from);
          if (stats.total_unpaid_sum > 0) {
              await whatsappService.sendTextMessage(from, `🚨 *Unpaid Invoices Alert*\n\nYou currently have *${stats.total_unpaid_sum}* pending to be paid by your clients across *${stats.invoicesCount}* issued invoices.\n\n_Log in to your portal to view full details._`);
          } else if (stats.invoicesCount > 0) {
              await whatsappService.sendTextMessage(from, `✅ *Great news!*\n\nAll your *${stats.invoicesCount}* issued invoices have been fully paid. Your accounts are currently up to date.`);
          } else {
              await whatsappService.sendTextMessage(from, `ℹ️ *No Invoices Found*\n\nYou haven't issued any invoices yet. You can start by sending a document or typing 'Create Invoice'.`);
          }
      } else if (interactiveId === 'rep_gen_search') {
          stateService.setUserState(from, 'AWAITING_REPORT_SEARCH');
          await whatsappService.sendTextMessage(from, "🔍 Please type the name of the Client or Supplier you are looking for:");
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
      const sections = [
        {
          title: "Standard Periods",
          rows: [
            { id: 'rep_period_this', title: 'This Month' },
            { id: 'rep_period_last', title: 'Last Month' },
            { id: 'rep_period_all', title: 'All Time' }
          ]
        },
        {
          title: "Custom Search",
          rows: [
            { id: 'rep_period_custom', title: 'Type Custom Month', description: 'Search any historical month' }
          ]
        }
      ];
      await whatsappService.sendInteractiveList(from, `📅 *Time Period*\n\nFor which time period would you like this report?`, "Select Period", sections);
  }

  async sendWelcomeMenu(from) {
    const body = `*Accounting Assistant Management Portal*\n\nPlease select an action below to manage your bookkeeping:`;
    const sections = [
      {
        title: "Primary Actions",
        rows: [
          { id: 'status', title: 'Account Status', description: 'Monthly financial summary' },
          { id: 'record', title: 'Record Expense', description: 'Submit an expense or receipt' },
          { id: 'inv', title: 'Record Invoice', description: 'Submit a sales invoice' },
          { id: 'stmt', title: 'Upload Statement', description: 'Upload bank statement (PDF)' },
          { id: 'quick_reports', title: 'Quick Reports', description: 'View client & supplier summaries' }
        ]
      }
    ];
    return whatsappService.sendInteractiveList(from, body, "Menu Actions", sections);
  }

  async sendStatusInteractive(from, stats) {
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

    // Currency formatting
    const currency = stats.currency || 'MAD';
    const fmt = (num) => {
        const val = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
        return `${val} ${currency}`;
    };

    // --- DETAILED SECTIONS ---
    let detailText = '';

    // Unpaid Invoices List
    if (invoices.length > 0) {
        detailText += `📑 *Unpaid Invoices (Top 3):*\n`;
        invoices.slice(0, 3).forEach(inv => {
            const client = inv.client?.client_name || 'Client';
            // Sum HT as a reasonable summary
            const amount = (inv.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
            detailText += `• ${client}: ${fmt(amount)}\n`;
        });
        detailText += `\n`;
    }

    // Recent Expenses List
    if (expenses.length > 0) {
        detailText += `🏷️ *Recent Expenses (Top 3):*\n`;
        expenses.slice(0, 3).forEach(exp => {
            const category = exp.category?.name || 'General';
            const amount = parseFloat(exp.total_ttc || 0);
            detailText += `• ${category}: ${fmt(amount)}\n`;
        });
        detailText += `\n`;
    }

    // Statement History Hint
    if (statements.length > 0) {
        const last = statements[0]; // Sorted DESC in backend
        detailText += `📅 *Last Statement:* ${last.month_year} (${last.status || 'Processed'})\n\n`;
    }

    const missingText = missing.length > 0 
        ? `⚠️ *Missing:* ${missing.join(', ')}\n_(Please upload these to the portal or send them here)_` 
        : (statusIcon === '🟢' 
            ? '✅ *All required documents received for this month.*'
            : (stats.monthStatus === 'MISSING_DOCUMENTS' 
                ? `🟠 *Note:* Some transaction receipts or missing details still need your attention in the portal.`
                : '✅ *All required documents received for this month.*'));

    let body = `📊 *Financial Summary:* ${stats.month}\n` +
               `━━━━━━━━━━━━━━━━━━\n\n` +
               `💶 *BUSINESS PERFORMANCE*\n` +
               `* Total Income:   ${fmt(income)}\n` +
               `* Total Expenses: ${fmt(expensesTotal)}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🏦 *NET BALANCE:  ${fmt(balance)}*\n\n` +
               `📋 *TAX & VAT ESTIMATE*\n` +
               `* VAT Payable:    ${fmt(vat)}\n\n` +
               `📈 *BOOKKEEPING PROGRESS*\n` +
               `* Status: ${statusIcon} ${statusText}\n\n` +
               detailText +
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
        notes = 'Business Expense';
    }

    let body = `*Reviewing Draft Expense:*\n` +
      `*Amount:* ${expenseData.amount} ${expenseData.currency || 'USD'}\n` +
      `*Date:* ${expenseData.date || 'Not provided'}\n` +
      `*Supplier:* ${expenseData.entity || 'General'}\n` +
      `*Category:* ${expenseData.category || 'General'}\n` +
      `*Payment Via:* ${expenseData.payment_method || 'WhatsApp'}\n` +
      `*Notes:* ${notes}\n\n`;

    if (receiptPath) {
      const fileName = path.basename(receiptPath);
      const isAudio = fileName.endsWith('.ogg');
      
      if (!isAudio) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `_Please confirm to save this entry._\n\n` +
                `📄 *Image Attached:*\n${previewUrl}`;
      } else {
        body += `🎙️ *Voice Note:* Processed\n\n_Please confirm the details extracted from your voice note._`;
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

    let body = `*Reviewing Draft Invoice:*\n` +
      `*Amount:* ${invoiceData.amount} ${invoiceData.currency || 'USD'}\n` +
      `*Date:* ${invoiceData.date || 'Not provided'}\n` +
      `*Client:* ${invoiceData.client_name || 'General'}\n`;

    // Robust Status Display
    const statusVal = (invoiceData.status || 'ISSUED').toUpperCase();
    const statusEmoji = statusVal.includes('PAID') ? '✅' : 
                        (statusVal.includes('PENDING') ? '⏳' : 
                        (statusVal.includes('ISSUED') ? '📑' : '📄'));
    
    body += `*Status:* ${statusVal} ${statusEmoji}\n` +
      `*Payment Via:* ${invoiceData.payment_method || 'WhatsApp'}\n` +
      `*Notes:* ${notes}\n\n`;

    if (filePath) {
      const fileName = path.basename(filePath);
      const isAudio = fileName.endsWith('.ogg');
      
      if (!isAudio) {
        const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
        body += `_Please confirm to generate your professional PDF._\n\n` +
                `📄 *Document Attached:*\n${previewUrl}`;
      } else {
        body += `🎙️ *Voice Note:* Processed\n\n_Please confirm the details extracted from your voice note._`;
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
      { id: 'ent', title: type === 'INVOICE' ? 'Client' : 'Supplier' },
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
      { id: 'Cash', title: 'Cash' },
      { id: 'Bank Transfer', title: 'Bank Transfer' },
      { id: 'Credit/Debit Card', title: 'Credit/Debit Card' },
      { id: 'Cheque', title: 'Cheque' },
      { id: 'Mobile Payment', title: 'Mobile Payment' },
      { id: 'Online Payment', title: 'Online Payment' },
      { id: 'Direct Debit', title: 'Direct Debit' },
      { id: 'Instant Bank Transfer', title: 'Instant Bank Transfer' },
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
    const rows = categories.slice(0, 9).map(cat => ({
        id: (cat.name || cat).substring(0, 200),
        title: (cat.name || cat).substring(0, 24)
    }));

    rows.push({ id: 'skip_category', title: 'Other / New Category', description: 'Type a custom category name' });

    const sections = [{ title: "Available Categories", rows }];
    return whatsappService.sendInteractiveList(from, body, "Category List", sections);
  }

  async sendSupplierSelectionList(from, suppliers) {
    const body = `Please select the Supplier for this expense:`;
    const rows = suppliers.slice(0, 9).map(s => ({
        id: s.name,
        title: s.name.substring(0, 24),
        description: `ID: ${s.id}`
    }));
    
    rows.push({ id: 'skip_supplier', title: 'Other / New Supplier', description: 'Type the name manually' });

    const sections = [{ title: "Your Suppliers", rows }];
    return whatsappService.sendInteractiveList(from, body, "Supplier List", sections);
  }

  async sendInvoiceStatusButtons(from) {
    const body = "What is the **Current Status** of this invoice?";
    const buttons = [
      { id: 'issued', title: 'Issued (Unpaid)' },
      { id: 'paid', title: 'Paid' },
      { id: 'draft', title: 'Draft' }
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
      await whatsappService.sendTextMessage(from, "Retrieving your account status summary...");
      const stats = await laravelService.getAccountStatus(from, filters.month, filters.year);
      const monthsLabel = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      let periodStr = filters.month ? `${monthsLabel[filters.month-1]} ` : "";
      periodStr += filters.year || (filters.month ? "" : "this month");
      
      return this.sendStatusInteractive(from, stats);
    }

    // Search for entity
    await whatsappService.sendTextMessage(from, `🔍 Searching for reports on "*${filters.entityName}*"...`);
    
    const [clients, suppliers] = await Promise.all([
      laravelService.getClients(from),
      laravelService.getSuppliers(from)
    ]);

    // Sanitize search: remove trailing punctuation and trim
    const search = filters.entityName.toLowerCase().replace(/[.,!?;:]+$/, "").trim();
    const matchedClients = (clients || []).filter(c => c.client_name.toLowerCase().includes(search));
    const matchedSuppliers = (suppliers || []).filter(s => s.name.toLowerCase().includes(search));

    const totalMatches = matchedClients.length + matchedSuppliers.length;

    if (totalMatches === 0) {
      await whatsappService.sendTextMessage(from, `❌ I couldn't find any Client or Supplier matching "*${filters.entityName}*".\n\nPlease try again with a different name.`);
      return;
    }

    if (totalMatches === 1) {
      const entity = matchedClients[0] || matchedSuppliers[0];
      const isClient = !!matchedClients[0];
      return this.sendFilteredReport(from, entity, isClient, filters);
    }

    // DISAMBIGUATION: Multiple matches found
    const combined = [
      ...matchedClients.map(c => ({ id: `rep_c_${c.id}`, title: `Client: ${c.client_name.substring(0,12)}` })),
      ...matchedSuppliers.map(s => ({ id: `rep_s_${s.id}`, title: `Supp: ${s.name.substring(0,13)}` }))
    ].slice(0, 3); // Max 3 buttons

    await whatsappService.sendInteractiveButtons(from, 
      `🤔 I found multiple matches for "*${filters.entityName}*". Which one did you mean?`,
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
      await whatsappService.sendTextMessage(from, "❌ Sorry, I couldn't find that record. Please try searching for them again.");
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
    const queryParams = {
      month: filters.month,
      year: filters.year
    };
    if (isClient) queryParams.client_id = entity.id;
    else queryParams.supplier_id = entity.id;

    const stats = await laravelService.getAccountStatus(from, queryParams.month, queryParams.year, queryParams.client_id, queryParams.supplier_id);
    
    if (!stats) {
      return whatsappService.sendTextMessage(from, "❌ I'm sorry, I couldn't retrieve the report data at this moment. Please try again later.");
    }
    
    const name = isClient ? entity.client_name : entity.name;
    const icon = isClient ? '👤' : '🚚';
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    let periodStr = 'All Time';
    if (filters.month || filters.year) {
      periodStr = (filters.month ? `${months[filters.month-1]} ` : "") + (filters.year || "");
    }

    let report = `${icon} *Report for ${name}*\n`;
    if (periodStr) report += `📅 *Period:* ${periodStr}\n`;
    report += `--- \n\n`;

    if (isClient) {
      // --- CLIENT VIEW (SALES) ---
      report += `💰 *Revenue:* ${(stats.salesSum || 0).toFixed(2)}\n`;
      report += `🕒 *Outstanding:* ${(stats.total_unpaid_sum || 0).toFixed(2)}\n`;
      report += `📈 *Quotes:* ${(stats.total_quote_sum || 0).toFixed(2)}\n`;
      report += `🏛️ *VAT Collected:* ${(stats.cash_vat_sum || 0).toFixed(2)}\n`;
    } else {
      // --- SUPPLIER VIEW (PURCHASES) ---
      report += `💸 *Total Expenses:* ${(stats.expensesSum || 0).toFixed(2)}\n`;
      report += `🏷️ *VAT Paid:* ${(stats.expenseVat || 0).toFixed(2)}\n`;
      report += `📋 *Records:* ${stats.expensesCount || 0} expenses\n`;
    }

    report += `\n_You can view the full transaction history for this filter in your portal._`;

    const monthPad = filters.month ? String(filters.month).padStart(2, '0') : '00';
    const yearPad = filters.year ? String(filters.year) : '0000';
    const listAction = isClient ? 'list_inv' : 'list_exp';
    const listButtonId = `${listAction}_${entity.id}_${monthPad}_${yearPad}`;
    const listButtonTitle = isClient ? '📄 List Invoices' : '📄 List Expenses';

    const recExpId = `record_exp_${entity.id}`;
    const recInvId = `record_inv_${entity.id}`;

    const buttons = [
      { id: listButtonId, title: listButtonTitle },
      { id: 'action_status', title: '📊 Status' }
    ];

    if (isClient) {
      buttons.push({ id: recInvId, title: '✍️ Record Invoice' });
    } else {
      buttons.push({ id: recExpId, title: '✍️ Record Expense' });
    }

    await whatsappService.sendInteractiveButtons(from, report, buttons);
  }

  /**
   * Drill-down handler for specific transaction lists
   */
  async handleListTransactions(from, type, entityId, month, year) {
    try {
      // 1. Fetch data
      let transactions = [];
      let title = "";

      if (type === 'inv') {
        transactions = await laravelService.getInvoices(from, null, month, year, entityId);
        title = "📑 Recent Invoices";
      } else {
        transactions = await laravelService.getExpenses(from, month, year, entityId);
        title = "💸 Recent Expenses";
      }

      if (transactions.length === 0) {
        return whatsappService.sendTextMessage(from, `ℹ️ No transactions found for this period.`);
      }

      // 2. Format list (Calculate total for ALL, but show only Top 10)
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const periodStr = month ? `${months[month-1]} ${year || ''}` : (year ? year : "All Time");
      
      let totalSum = 0;
      let currency = 'MAD';

      // 1. Calculate TOTAL for everything found
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

      // 2. Build rows for only Top 10 (WhatsApp Limit)
      const rows = transactions.slice(0, 10).map((t) => {
        const date = t.date ? new Date(t.date).toLocaleDateString('en-GB') : 'N/A';
        
        let amount = 0;
        if (type === 'inv') {
          amount = (t.articles || []).reduce((sum, art) => sum + parseFloat(art.total_price_ht || 0), 0);
        } else {
          amount = parseFloat(t.total_ttc || t.ttc || 0);
        }

        const fmtAmount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(amount) + ' ' + (t.currency || currency);
        const prefix = type === 'inv' ? 'v_inv_' : 'v_exp_';

        return {
           id: `${prefix}${t.id}`,
           title: `${date} — ${fmtAmount}`,
           description: t.notes || (type === 'inv' ? `Invoice #${t.id}` : `Expense #${t.id}`)
        };
      });

      const fmtTotal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(totalSum) + ' ' + currency;
      
      const bodyText = `*${title}*\n` +
                       `📅 *Period:* ${periodStr}\n` +
                       `💰 *Total:* ${fmtTotal}\n\n` +
                       `I found ${transactions.length} records. Tap below to view or download a specific document:`;

      const sections = [{
          title: "Select Document",
          rows: rows
      }];

      await whatsappService.sendInteractiveList(from, bodyText, "View Documents", sections);

    } catch (error) {
      console.error('handleListTransactions error:', error);
      await whatsappService.sendTextMessage(from, "❌ Sorry, I encountered an error while fetching the transaction list.");
    }
  }
  /**
   * Fetch and deliver a specific invoice or expense document natively
   */
  async handleDeliverSpecificMedia(from, type, id) {
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
        return whatsappService.sendTextMessage(from, `❌ Sorry, I couldn't find the original file for ${label} #${id}.`);
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
      const entityLabel = type === 'inv' ? 'Client' : 'Supplier';

      const successText = `🧾 *${label.toUpperCase()} DOCUMENT*\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🏢 *${entityLabel}:* ${entityName}\n` +
                          `💰 *Amount:* ${fmtAmount}\n` +
                          `📅 *Date:* ${date}\n` +
                          `📝 *Notes:* ${document.notes || document.description || 'N/A'}\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `✅ *Status:* ${document.status || 'Recorded'}`;
      
      const isPdfRoute = document.download_url.includes('/pdf');
      const isImage = document.document_path && (
          document.document_path.toLowerCase().endsWith('.jpg') || 
          document.document_path.toLowerCase().endsWith('.jpeg') || 
          document.document_path.toLowerCase().endsWith('.png')
      );

      if (!isPdfRoute && isImage) {
          await whatsappService.sendImage(from, document.download_url, successText);
      } else {
          await whatsappService.sendDocument(from, document.download_url, `${label}_${id}.pdf`, successText);
      }

    } catch (error) {
      console.error('handleDeliverSpecificMedia error:', error);
      await whatsappService.sendTextMessage(from, "❌ Sorry, I encountered an error while delivering that document.");
    }
  }
}

module.exports = new WhatsAppController();
