Here is the **"Ready-to-Send"** version of the test pack. You can copy this entire block and send it directly to your product team via Slack, Email, or WhatsApp.

***

# 📑 Product Team: WhatsApp Accounting Bot (Test Guide)

Use the following commands to test the **AI Extraction**, **Financial Intelligence**, and **Smart Status Dashboard**.

---

### 💰 1. Record Income (Money In)
*Copy and paste these to verify "Inflow" logic:*
*   `Billed Amazon 1500 for consulting services via transfer`
*   `New invoice to Google for 2000 EUR on April 5th`
*   `Sold services to Microsoft for 500 dollars`

---

### 💸 2. Record Expenses (Money Out)
*Copy and paste these to verify "Outflow" logic:*
*   `Paid Google 50.00 for cloud fees via transfer`
*   `Yesterday I spent 25.50 at Starbucks for lunch`
*   `I just bought a coffee at Starbucks for 5.50 using cash`

---

### 🎙️ 3. Voice Note Scripts
*Record these as a voice note to test transcription & extraction:*
*   *"I just **paid** fifty dollars for my internet bill at Comcast."* (**Expense**)
*   *"I am **billing** my client Apple for two thousand dollars today."* (**Invoice**)

---

### 🔄 4. Missing Data & Interactive Steps
*Test if the bot intelligently asks for missing info:*
1.  **Forgot Amount**: `Lunch at McDonalds yesterday` ➔ *(Bot should ask for price)*.
2.  **Forgot Supplier**: `I spent 150 on hotel` ➔ *(Bot should ask for name)*.
3.  **Manual Flow**: `Record an expense` ➔ *(Bot should start step-by-step chat)*.

---

### 🏦 5. Bank Statements
1.  **Action**: Upload any document (Image or PDF).
2.  **Response**: `Last month` ➔ *(AI should calculate the previous month, e.g., March 2026)*.
3.  **Response**: `March 2030` ➔ *(Bot should reject as it's a future date)*.

---

### 📊 6. The "Smart Dashboard" (Financial Health)
*Send `Status` to check the icons:*
*   **🟢 Green**: Show if 1+ Statement and 1+ Invoice exist.
*   **🟡 Yellow**: Show if data exists but hasn't been validated on the portal.
*   **🟠 Orange**: Show if either the statement or invoices are missing.

---

### 💡 Core Logics to Note:
*   **"Paid"** is strictly an **Expense**.
*   **"Billed"** is strictly an **Invoice**.
*   **Security**: There is a **10-second anti-spam delay** between messages.
*   **Limits**: Total AI requests are capped at **30 per day** per user.

***