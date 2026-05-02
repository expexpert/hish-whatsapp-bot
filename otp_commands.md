# WhatsApp Bot OTP API Reference 🔐

This document provides `curl` commands for the three main OTP-related actions: requesting activation, verifying the code, and triggering a direct message from the bot.

## 1. Request Activation OTP
This endpoint is called by the **Web Portal** (after user login) to start the WhatsApp activation process.

```bash
curl -s --location 'http://localhost:8000/api/customer/bot/request-activation' \
--header 'Authorization: Bearer 5|ds3p9v9lH5Y3HPlCMYhi5Jkj4H5kbj0sf9hg7KwW7b0f4f9d' \
--header 'Content-Type: application/json' \
--data '{
    "phone": "919304220627"
}'
```

*   **Logic**: Generates a 4-digit code, saves it to the `customers` table, and triggers the bot to send it.
*   **Response**: `{"status": "success", "message": "...", "debug_otp": 1234}` (Debug OTP included for testing).

---

## 2. Verify Activation OTP
This endpoint is called by the **Web Portal** to finalize the link between the user and the WhatsApp bot.

```bash
curl -s --location 'http://localhost:8000/api/customer/bot/verify-activation' \
--header 'Authorization: Bearer 5|ds3p9v9lH5Y3HPlCMYhi5Jkj4H5kbj0sf9hg7KwW7b0f4f9d' \
--header 'Content-Type: application/json' \
--data '{
    "phone": "919304220627",
    "otp": "7213"
}'
```

*   **Logic**: Validates the code. If correct, sets `bot_active = 1` and `bot_activated_at = now()` in the database.
*   **Response**: `{"status": "success", "message": "WhatsApp Bot activated successfully!"}`

---

## 3. Direct OTP Trigger (Internal Bot API)
This is the **Internal Bridge**. It is used by the Laravel backend to tell the Node.js bot to send a message. You can use it manually to test the bot's messaging capability.

```bash
curl --location 'http://localhost:3005/api/v1/bot/send-otp' \
--header 'X-Bot-Secret: {{WHATSAPP_BOT_SECRET}}' \
--header 'Content-Type: application/json' \
--data '{
    "phone": "212600000000",
    "otp": "9999"
}'
```

*   **Environment Variables**:
    *   `{{WHATSAPP_BOT_SECRET}}`: Found in your Laravel `.env` (defaults to `69c932e7409a99b491c44789314ae787`).
    *   **Port**: Defaults to `3005`.

---

## 4. Customer Login (Get Sanctum Token)
Use this to authenticate and get the `{{USER_TOKEN}}` required for other endpoints.

```bash
curl -s --location 'http://localhost:8000/api/customer/login' \
--header 'Content-Type: application/json' \
--data '{
    "email": "seed_test@example.com",
    "password": "123456"
}'
```

*   **Response**: `{"token": "1|abc...", "customer": {...}}`
*   **Next Step**: Copy the `token` and use it as `Authorization: Bearer {{USER_TOKEN}}` in the other calls.

---

> [!IMPORTANT]
> - Ensure **NGROK** or your public URL is used if testing from outside the server.
> - The `phone` number should be in international format without the `+` prefix.
