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
      const isAuth = await laravelService.checkAuth(from);
      console.log(`🔍 [DEBUG] Auth check result for ${from}: ${isAuth}`);

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

        // --- Exit/Cancel Handler ---
        if (textLower === 'exit' || textLower === 'cancel' || textLower === 'stop' || textLower === 'menu' || textLower === 'quit') {
            stateService.clearUserState(from);
            await whatsappService.sendTextMessage(from, "Process cancelled. Returning to main menu...");
            await this.sendWelcomeMenu(from);
            return;
        }

        // Check for 'STATUS', 'Account Status', or Interactive ID 'status'
        if (textLower === 'status' || textLower === 'account status' || interactiveId === 'status' || textLower.includes('dashboard')) {
            await whatsappService.sendTextMessage(from, "Retrieving your account status summary...");
            const stats = await laravelService.getAccountStatus(from);
            await this.sendStatusInteractive(from, stats);
            return;
        }

        // Check for Menu Triggers
        if (textLower === 'record expense') {
          await whatsappService.sendTextMessage(from, "Please provide the expense details or upload a receipt photo/audio note.\nExample: '150.00 for office supplies'");
          return;
        }
        if (textLower === 'record invoice') {
          await whatsappService.sendTextMessage(from, "Please provide the invoice details or upload the document (PDF/Image).\nExample: '500.00 invoice for ABC Consulting'");
          return;
        }
        if (textLower === 'upload statement') {
          await whatsappService.sendTextMessage(from, "Please upload your Bank Statement in PDF format.");
          return;
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
              feedback += "\nYour document has been synchronized with the portal.";
              let finalUrl = result.file_url;
              if (state.data.receiptPath) {
                const path = require('path');
                const fileName = path.basename(state.data.receiptPath);
                finalUrl = `${config.botPublicUrl}/storage/${fileName}`;
              }
              
              if (finalUrl) {
                feedback += `\n\nView Document: ${finalUrl}`;
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
            state.state === 'AWAITING_DATE_EDIT' || state.state === 'AWAITING_DATE_EDIT_INVOICE') {
            
            const isInvoice = state.state.endsWith('_INVOICE');
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
        if (state.state === 'AWAITING_STATEMENT_MONTH') {
            const monthYear = text;
            
            if (!state.data.filePath) {
                // If no file was provided yet, keep the state but remind them to upload the PDF
                state.data.monthYear = monthYear; // Save the month for later
                stateService.setUserState(from, 'AWAITING_STATEMENT_FILE', state.data);
                await whatsappService.sendTextMessage(from, `Got it. Statement for ${monthYear}.\n\n📎 Please upload the PDF or Image of the statement to complete the record.`);
                return;
            }

            await whatsappService.sendTextMessage(from, `Processing statement for ${monthYear}...`);
            await laravelService.uploadStatement(state.data.filePath, from, monthYear);
            await whatsappService.sendTextMessage(from, "Bank statement successfully uploaded to the portal.");
            stateService.setUserState(from, 'IDLE');
            await this.sendWelcomeMenu(from);
            return;
        }

        // --- Handle Statement File Upload (If month was provided first) ---
        if (state.state === 'AWAITING_STATEMENT_FILE' && (type === 'image' || type === 'document')) {
            // This is handled by handleDocumentRouting
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

            if (state.data.invoiceData.payment_method && state.data.invoiceData.payment_method !== 'WhatsApp') {
                stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', state.data);
                await this.sendInvoiceReviewButtons(from, state.data.invoiceData, state.data.filePath);
            } else {
                stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', state.data);
                await this.sendPaymentMethodSelectionList(from);
            }
            return;
        }

        // --- Handle Invoice Date Selection ---
        if (state.state === 'AWAITING_INVOICE_DATE') {
            state.data.invoiceData.date = text.trim();
            
            const clients = await laravelService.getClients(from);
            if (clients && clients.length > 0) {
                stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', state.data);
                await this.sendClientSelectionList(from, clients);
            } else {
                stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', state.data);
                await whatsappService.sendTextMessage(from, "No existing clients found. Please type the **Name of the Client** for this invoice:");
            }
            return;
        }
        
        // --- Handle New Client Name Entry ---
        if (state.state === 'AWAITING_NEW_CLIENT_NAME') {
            state.data.invoiceData.client_name = text.trim();
            stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', state.data);
            await this.sendPaymentMethodSelectionList(from);
            return;
        }

        // --- Handle Invoice Payment Method Selection ---
        if (state.state === 'AWAITING_INVOICE_PAYMENT_METHOD') {
            state.data.invoiceData.payment_method = interactiveId || text;

            stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', state.data);
            await this.sendInvoiceReviewButtons(from, state.data.invoiceData, state.data.filePath);
            return;
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

        // 1. Text & Unified Document Parsing
        const isCommand = textLower.startsWith('expense') || 
                          textLower.startsWith('invoice') || 
                          textLower.startsWith('statement') || 
                          text.split(' ').length > 2;

        if (type === 'text' && isCommand) {
            try {
                const categories = await laravelService.getCategories();
                const data = await aiService.parseExpenseText(text, categories, from);
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

            if (!isCapturing) {
                await whatsappService.sendTextMessage(from, `Analyzing ${type} attachment...`);
            } else {
                await whatsappService.sendTextMessage(from, `Linking ${type} to current record...`);
            }
            
            const mediaId = message[type].id;
            const extension = type === 'image' ? 'jpg' : (type === 'audio' ? 'ogg' : (message.document.filename?.split('.').pop() || 'pdf'));
            const localPath = await storageService.downloadMedia(mediaId, `${type}_${Date.now()}.${extension}`);
            
            // --- Size Validation ---
            const stats = fs.statSync(localPath);
            const fileSizeInMegabytes = stats.size / (1024 * 1024);
            if (fileSizeInMegabytes > 2.0) {
                await whatsappService.sendTextMessage(from, 
                    `File exceeds the 2MB size limit. Current size: ${fileSizeInMegabytes.toFixed(2)}MB.\n\n` +
                    "Please provide a smaller file or a relevant photo to ensure synchronization."
                );
                // Clean up
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                return;
            }

            let data = {};
            const categories = await laravelService.getCategories();

            if (!isCapturing) {
                try {
                    if (type === 'audio') {
                        const transcription = await aiService.transcribeVoice(localPath, from);
                        const transLower = transcription.toLowerCase();
                        
                        // Check if transcription is a request for Account Status
                        if (transLower.includes('status') || transLower.includes('dashboard') || transLower.includes('report')) {
                            await whatsappService.sendTextMessage(from, "Retrieving your account status summary from voice command...");
                            const stats = await laravelService.getAccountStatus(from);
                            await this.sendStatusInteractive(from, stats);
                            return;
                        }

                        data = await aiService.parseExpenseText(transcription, categories, from);
                    } else if (type === 'image') {
                        data = await aiService.parseReceiptImage(localPath, categories, from);
                    } else {
                        // Documents (PDF)
                        let documentType = extension === 'pdf' ? 'STATEMENT' : 'EXPENSE';
                        if (interactiveId === 'inv') documentType = 'INVOICE';
                        else if (interactiveId === 'stmt') documentType = 'STATEMENT';
                        
                        data = { documentType, description: `Document: ${message.document?.filename || 'PDF Attachment'}` };
                    }
                } catch (error) {
                    if (error.message.includes("quota") || error.message.includes("limit")) {
                        await whatsappService.sendTextMessage(from, `🛑 *AI Limit Reached*\n\n${error.message}`);
                        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                        return;
                    } else {
                        throw error;
                    }
                }
            } else {
                // If already capturing, we infer the documentType from the state and skip AI
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
  
    // AI uses 'entity' but invoices use 'client_name' - unify for routing logic
    if (mergedData.documentType === 'INVOICE' && mergedData.entity && mergedData.entity !== 'General' && !mergedData.client_name) {
        mergedData.client_name = mergedData.entity;
    }
 
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

    if (mergedData.documentType === 'STATEMENT') {
        const monthYear = mergedData.monthYear || (isCapturing && currentState.data?.monthYear);

        if (monthYear && filePath && type !== 'audio') {
            // We have both! (e.g. PDF sent with "April 2026" as caption)
            await whatsappService.sendTextMessage(from, `Processing statement for ${monthYear}...`);
            await laravelService.uploadStatement(filePath, from, monthYear);
            await whatsappService.sendTextMessage(from, "Bank statement successfully uploaded to the portal.");
            stateService.clearUserState(from);
            await this.sendWelcomeMenu(from);
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
        // Smart Flow for Invoices: Handle both manual entry and list selection
        const inv = mergedData;
        const today = new Date().toISOString().split('T')[0];
        
        if (!inv.date || inv.date === today) {
            stateService.setUserState(from, 'AWAITING_INVOICE_DATE', { filePath, invoiceData: inv });
            await whatsappService.sendTextMessage(from, "Invoice detected. Please provide the Invoice Date (e.g., 2026-04-02):");
        } else if (!inv.client_id && !inv.client_name) {
            const clients = await laravelService.getClients(from);
            if (clients && clients.length > 0) {
                stateService.setUserState(from, 'AWAITING_INVOICE_CLIENT', { filePath, invoiceData: inv });
                await this.sendClientSelectionList(from, clients);
            } else {
                stateService.setUserState(from, 'AWAITING_NEW_CLIENT_NAME', { filePath, invoiceData: inv });
                await whatsappService.sendTextMessage(from, "No existing clients found. Please type the **Name of the Client** for this invoice:");
            }
        } else if (!inv.payment_method || inv.payment_method === 'WhatsApp') {
            stateService.setUserState(from, 'AWAITING_INVOICE_PAYMENT_METHOD', { filePath, invoiceData: inv });
            await this.sendPaymentMethodSelectionList(from);
        } else {
            stateService.setUserState(from, 'AWAITING_INVOICE_CONFIRMATION', { filePath, invoiceData: inv });
            await this.sendInvoiceReviewButtons(from, inv, filePath);
        }
    } else {
        // Default: EXPENSE
        if (mergedData.amount || filePath) {
            const today = new Date().toISOString().split('T')[0];
            if (!mergedData.date) mergedData.date = today;

            // Smart Flow: Check for missing fields before confirmation
            if (!mergedData.category) {
                const categories = await laravelService.getCategories();
                stateService.setUserState(from, 'AWAITING_EXPENSE_CATEGORY', { expenseData: mergedData, receiptPath: filePath });
                await this.sendCategorySelectionList(from, categories);
            } else if (!mergedData.entity || mergedData.entity === 'General') {
                const suppliers = await laravelService.getSuppliers(from);
                if (suppliers && suppliers.length > 0) {
                    stateService.setUserState(from, 'AWAITING_EXPENSE_ENTITY', { expenseData: mergedData, receiptPath: filePath });
                    await this.sendSupplierSelectionList(from, suppliers);
                } else {
                    // No suppliers found, ask to type it or skip
                    stateService.setUserState(from, 'AWAITING_ENTITY_EDIT', { expenseData: mergedData, receiptPath: filePath });
                    await whatsappService.sendTextMessage(from, "The AI couldn't identify the supplier. Please type the Supplier/Entity name (or type 'General' to skip):");
                }
            } else if (!mergedData.payment_method || mergedData.payment_method === 'WhatsApp') {
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
    let statusText = 'validated';
    if (stats.invoicesCount > 0 && stats.pendingReviewCount > 0) {
      statusText = 'pending review by accountant';
    } else if (stats.invoicesCount === 0) {
      statusText = 'Active'; // Neutral status if no invoices to review
    }

    const missing = [];
    if (!stats.statementsCount) missing.push('bank statement');
    if (stats.invoicesCount === 0) missing.push('invoice');
    
    const missingText = missing.length > 0 ? missing.join(', ') : 'None';

    let body = `*Monthly Status Report:* ${stats.month}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `Total Documents: ${stats.totalDocuments}\n` +
               `* Invoices: ${stats.invoicesCount}\n` +
               `* Expenses: ${stats.expensesCount}\n` +
               `* Statements: ${stats.statementsCount}\n` +
               `* Pending Review: ${stats.pendingReviewCount}\n\n` +
               `status: ${statusText}\n` +
               `missing documents: ${missingText}`;
    
    const buttons = [
      { id: 'record', title: 'Record Expense' },
      { id: 'menu', title: 'Main Menu' }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendExpenseReviewButtons(from, expenseData, receiptPath = null) {
    const path = require('path');
    let body = `Reviewing Draft Entry:\n` +
      `Amount: ${expenseData.amount} ${expenseData.currency || 'USD'}\n` +
      `Date: ${expenseData.date || 'Not provided'}\n` +
      `Supplier: ${expenseData.entity || 'General'}\n` +
      `Category: ${expenseData.category || 'General'}\n` +
      `Payment Via: ${expenseData.payment_method || 'WhatsApp'}\n` +
      `Description: ${expenseData.description || 'Not provided'}\n\n`;

    if (receiptPath) {
      const fileName = path.basename(receiptPath);
      const isAudio = fileName.endsWith('.ogg');
      const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
      body += `${isAudio ? 'Voice Note' : 'Receipt Image'}: Attached\nPreview: ${previewUrl}\n\nPlease confirm to save this entry.`;
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
    let body = `Reviewing Draft Invoice:\n` +
      `Amount: ${invoiceData.amount} ${invoiceData.currency || 'USD'}\n` +
      `Date: ${invoiceData.date || 'Not provided'}\n` +
      `Client: ${invoiceData.client_name || 'General'}\n` +
      `Payment Via: ${invoiceData.payment_method || 'Not provided'}\n` +
      `Notes: ${invoiceData.description || 'Not provided'}\n\n`;

    if (filePath) {
      const fileName = path.basename(filePath);
      const isAudio = fileName.endsWith('.ogg');
      const previewUrl = `${config.botPublicUrl}/storage/${fileName}`;
      body += `${isAudio ? 'Voice Note' : 'Invoice Document'}: Attached\nPreview: ${previewUrl}\n\nPlease confirm to save this entry.`;
    } else {
      body += `You may upload the invoice document (PDF/Image) now to link it, or confirm to save as text-only.`;
    }
    
    const buttons = [
      { id: 'confirm', title: 'Confirm' },
      { id: 'edit', title: 'Edit' }
    ];
    return whatsappService.sendInteractiveButtons(from, body, buttons);
  }

  async sendEditSelectionButtons(from, type = 'EXPENSE') {
    const body = `Select the field you wish to modify:`;
    let rows = [
      { id: 'amt', title: 'Amount' },
      { id: 'date', title: 'Date' },
      { id: 'ent', title: type === 'INVOICE' ? 'Client' : 'Entity' },
      { id: 'cat', title: 'Category' },
      { id: 'pay', title: 'Payment Via' }
    ];

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
    const rows = clients.slice(0, 10).map(client => ({
        id: `${client.id}`,
        title: client.company_name || client.client_name,
        description: `Customer ID: ${client.id}`
    }));

    rows.push({ id: 'skip_client', title: 'Other / New Client', description: 'Type the name manually' });

    const sections = [{ title: "Registered Clients", rows }];
    return whatsappService.sendInteractiveList(from, body, "Client List", sections);
  }

  async sendCategorySelectionList(from, categories) {
    const body = `Please select the Category for this expense:`;
    const rows = categories.map(cat => ({
        id: cat.name || cat,
        title: cat.name || cat
    }));

    const sections = [{ title: "Available Categories", rows }];
    return whatsappService.sendInteractiveList(from, body, "Category List", sections);
  }

  async sendSupplierSelectionList(from, suppliers) {
    const body = `Please select the Supplier/Entity for this expense:`;
    const rows = suppliers.slice(0, 10).map(s => ({
        id: s.name,
        title: s.name,
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
