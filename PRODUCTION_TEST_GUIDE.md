# 🚀 Master Production Testing Guide (EN/FR)

This guide covers all core features of the **SaaS Accountant Bot**, including the newly implemented **Fuzzy Matching**, **Bilingual Logic**, and **Smart Logging**.

---

## 🌍 1. Language & Session Testing
*The bot detects your language naturally or via manual settings.*

| Goal | Action (User) | Expected Result |
| :--- | :--- | :--- |
| **Switch to French** | `Bonjour`, `Comptabilité`, `Rapports`, `Salut` | Bot responds in French. |
| **Switch to English** | `Hello`, `Hi`, `Dashboard`, `Reports` | Bot responds in English. |
| **Hybrid Intent** | `Rapport for last month` | Bot detects EN intent and switches if needed. |
| **Reset Session** | `Annuler`, `Cancel`, `Stop`, `Quitter` | Current workflow ends. |

---

## 🔍 2. Report Fuzzy Matching (The "Typo" Stress Test)
*Verify the Dice Coefficient logic against common spelling errors.*

### Variants for Raman Sharma
- `Report for Rman Shrma for March` (Missing vowels + month)
- `Rapport pour Raman Charma en Avril` (Phonetic swap + French month)
- `Show me Raman Sarma for last month` (S/Sh swap + relative period)

### Variants for Nitesh Arya
- `Nitsh Aria March report` (Phonetic swap + trailing month)
- `Rapport pour Nitesh Area de Février` (Spelling variant + French month)
- `Details on Nitesh for Jan 24` (Partial name + year shortcut)

### Variants for Swapan Kumar
- `Report for Swapan Kmar for this month` (Missing vowel + dynamic period)
- `Searching for Swaapan Kumar May summary` (Double vowel + month)
- `Who is Swapan? Performance for 2023` (Short name + yearly report)

---

## 🎙️ 3. Audio & Transcription Variants
*Verify the Language Lockdown (No Devanagari leakage).*

- **EN High Noise**: Record while clapping: *"Record 50 dollars for office supplies."*
- **FR Rapid Speech**: *"J'ai facturé deux mille dirhams à mon client Microsoft."*
- **EN Slang**: *"Spent 50 bucks at Starbucks for coffee."*
- **FR Specific Category**: *"Paiement de cinq cents pour le loyer du bureau."*

---

## 💶 4. Accounting Workflow Variants

### 🇬🇧 English Income/Expense Variants
- `Billed Amazon 1.2k for services` (K-multiplier test)
- `Spent $50 on lunches yesterday` (Symbol recognition)
- `Paid Google 50.55 via credit card` (Payment method trigger)
- `Invoice MSFT for 2000` (Abbreviation/Acronym)

### 🇫🇷 French Income/Expense Variants
- `Facture à Microsoft 3000 euros` (Terminology check)
- `Payé 50dh pour internet avec cash` (Currency + Payment)
- `Dépense de 150 chez Total pour essence` (Category sensing)
- `Nouveau client: Google 500.00` (Intent sensing)

---

## 📊 5. Financial Reporting Variants
*Natural language queries for deep stats.*

- **Timeline**: `Total since January`, `How much in 2024?`, `Bilan de l'année`
- **Synonym Search (EN)**: `Summary for Raman`, `Breakdown of Nitesh`, `Details on Swapan`, `Stats for March`
- **Synonym Search (FR)**: `Résumé pour Raman`, `Détails de Nitesh`, `Historique de Swapan`, `Chiffres du mois`
- **Category Specific**: `How much did I spend on coffee?` or `Mes dépenses internet`
- **Tax Focused**: `What is my VAT for March?` or `TVA du mois dernier`
- **Performance**: `How am I doing this month?` or `Mon solde actuel`
- **Unpaid Search**: `Who owes me money?` or `Factures non payées`

---

## ⚙️ 6. Admin & Health (DEBUG Toggle)
*Verify the production silence vs. debug visibility.*

### Production Mode
1. **Config**: Set `DEBUG=false` in `.env`.
2. **Action**: Use the bot.
3. **Verify**: The terminal should **only** show the "Server is running" and errors. No webhook data should appear.

### Debug/Dev Mode
1. **Config**: Set `DEBUG=true` in `.env`.
2. **Action**: Use the bot.
3. **Verify**: Full `🔍 [DEBUG]` logs appear, including `📬 NEW WEBHOOK EVENT` and `🤖 AI INTENT SENSING`.

---

## 🚨 Critical Success Indicators
- [x] **No English Leak**: In French mode, payment methods show "Virement/Espèces," not "Transfer/Cash."
- [x] **Script Sanity**: No Devanagari/Hindi script appears in transcriptions.
- [x] **Smart Fallback**: Typo "Sarma" correctly reaches "Sharma."
