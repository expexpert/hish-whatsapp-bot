# Project Conversation State & Handover

**Date**: 2026-04-21  
**Project**: bilingual WhatsApp Accounting Bot (Node.js) + Laravel Dashboard (PHP)

---

## 🎯 Current Objectives
1.  **Bilingual VAT Flow**: DONE - Full localization (FR/EN) for the VAT selection process.
2.  **Compulsory VAT Choice**: DONE - Users must select a tax from the DB before saving an invoice.

## 🚀 Recent Achievements
- **Bilingual Localization**:
    - Moved all VAT strings to `i18n.js`.
    - Added `localizeTaxName` helper to translate "VAT" to "TVA" dynamically for French users.
- **Forced VAT Selection**:
    - Bot pauses for VAT selection before invoice confirmation.
    - Uses interactive buttons or list depending on the number of taxes.

## 📋 Technical Context
- **i18n**: `src/utils/i18n.js` contains all localized strings.
- **Controller Logic**: `whatsapp.controller.js` handles the state transition to `AWAITING_INVOICE_VAT`.

## 📝 Pending Tasks
- [x] Implement Bilingual VAT Flow.
- [x] Add dynamic "VAT" -> "TVA" translation logic.
- [ ] User feedback on the localized experience.

---
*Note: This file is created as a heartbeat to ensure project progress is never lost even if conversation history is unavailable.*
