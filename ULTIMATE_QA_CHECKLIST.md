# 🏆 Ultimate WhatsApp Bot QA & Reporting Checklist

Use this guide to perform a "Full-Fledged" test of the bot, from recording data to extracting complex financial reports.

---

## 📊 Phase 1: Quick Reports & Dashboard (Multilingual Triggers)
*Verify the "Financial Heart" of the bot and its language sensing.*

| Test Case | Command Keywords (English) | Command Keywords (Français) | Expected Result |
| :--- | :--- | :--- | :--- |
| **Instant Dashboard** | `Status`, `Balance`, `Dashboard` | `Statut`, `Solde`, `Tableau`, `Compte` | Shows Income, Total Expenses, Balance, and VAT. Checks language preference. |
| **Main Menu** | `Menu`, `Start`, `Home` | `Menu`, `Bonjour`, `Salut`, `Début` | Opens the interactive task list and resets language. |
| **Report Menu** | `Report`, `Summary` | `Rapport`, `Résumé` | Opens the filtered report selection menu. |
| **Unpaid Focus** | `Unpaid`, `Owed` | `Impayées`, `Dues` | Shows total sum of unpaid invoices only. |

---

## 🔍 Phase 2: Entity-Specific Reports (Drill Down)
*Test the bot's ability to filter and search.*

1. **The Search Flow**:
   - Send `Report` ➔ Select **"Search by Name"** / **"Rechercher par nom"**.
   - Input: `Carrefour`.
   - **Expected**: It should find Carrefour, show recent expenses, and offer a "View List" button.

2. **The List View**:
   - Click **"View List"** / **"Voir la liste"** on any report.
   - **Expected**: A list of the last 10 transactions with dates and formatted amounts (MAD/EUR).

3. **Client vs. Supplier**:
   - Run report for a **Client** (e.g., Apple). ➔ Should show **Revenue & Outstanding**.
   - Run report for a **Supplier** (e.g., Carrefour). ➔ Should show **Expenses & VAT Paid**.

---

## 💸 Phase 3: "Smart" Recording (Multi-Language)
*Test the AI's ability to understand context.*

| Scenario | Message to Send | Logic to Verify |
| :--- | :--- | :--- |
| **Complex English** | `I paid 450 MAD to Maroc Telecom for internet yesterday via card` | Correct Category (Utilities), Date (Yesterday), Method (Card). |
| **Complex French** | `J'ai versé 5000 MAD à mon expert-comptable par virement` | Correct Entity (Accountant), Type (Expense), Method (Transfer). |
| **Mixed Intent** | `Invoice for 200 EUR from Amazon` | Should detect as **Expense** (from Amazon) vs. **Billed to Amazon** (Invoice). |

---

## 🏢 Phase 4: Specialized Entity Testing (Nitches & Arya)
*Verify reporting for your specific priority clients and suppliers.*

| Entity | Type | Test Sentence | Expected Report Data |
| :--- | :--- | :--- | :--- |
| **Nitesh** | Supplier | `Spent 1200 MAD at Nitesh for consulting` | **Expenses**: 1200, **VAT Paid**: (Calculated), **Records**: +1 |
| **Arya** | Client | `Billed Arya 5000 MAD for service delivery` | **Revenue**: 5000, **Outstanding**: 5000, **Records**: +1 |

### 🛠️ Advanced AI Drill-downs (Bilingual Combined Filters)
*Test natural language searches for specific entities and periods.*

| Test Scenario | English Sentence | French Sentence | Expected Logic |
| :--- | :--- | :--- | :--- |
| **Specific Status** | `"status for nitesh arya"` | `"statut pour nitesh arya"` | Dashboard for Nitesh Arya. |
| **Filtered Reports**| `"report for nitesh arya"` | `"rapport pour nitesh arya"` | Drill-down pre-filtered for Entity. |
| **Monthly summary**| `"status of month january"`| `"statut du mois de janvier"`| Full stats for January only. |
| **Combined Search** | `"report nitesh arya jan"` | `"rapport nitesh arya jan"` | Filtered by Entity + Month. |

---

## 🎙️ Phase 5: Voice & Media Extraction

- **Voice Test**: *"I spent twenty euros on fuel at TotalEnergies."*
  - **Verify**: The bot should confirm: **Amount: 20 EUR**, **Entity: TotalEnergies**.
- **Image Test**: Send a photo of a receipt.
  - **Verify**: The bot should say *"Analyzing media..."*, extract data, and present the **Review Buttons**.

---

## 🛠️ Phase 5: Financial Logic Validation (Hardening)
*Check the numbers following your recent updates.*

1. **Balance Formula**: 
   - `Balance = Total Income - Total Expenses (Gross)`.
   - Send `Status` and manually check if the math adds up using the numbers shown.
2. **VAT Collection**:
   - Send `Report` for a Client.
   - **Check**: Is "VAT Collected" only showing the sum of sales tax (excluding expense VAT)?
3. **Empty States**:
   - Search for a name that doesn't exist (e.g., `Zebra Corp`).
   - **Expected**: "I couldn't find any record... search again?".

---

## 🌐 Phase 6: Bilingual Continuity
- Start a flow in **English** (`Record expense`).
- Suddenly reply in **French** (`C'est pour le déjeuner`).
- **Expected**: The bot should continue the flow but switch its response language to French.

---

> [!TIP]
> **Pro Tip**: Use the `saas_accountant_bot.zip` for deployment to staging for a clean test environment. Always check `bot_server.log` if the AI fails to extract a complex sentence.
