# Advanced Meta WhatsApp API Integration

This is a production-grade Node.js integration for the **Meta WhatsApp Business Cloud API (v22.0)**. 

## 🚀 Features
- **Dynamic Template Sender**: Send any Meta-approved template with headers, body variables, and buttons.
- **Webhook Implementation**: Both verification (GET) and event processing (POST).
- **Security Check**: Middleware for `X-Hub-Signature-256` to ensure requests only come from Meta.
- **Error Handling**: Comprehensive logging for API failures.
- **Modular Structure**: Clean separation of routes, controllers, and services.

## ⚙️ Configuration
Update the `.env` file with your credentials:
```env
WHATSAPP_PHONE_NUMBER_ID=1009790575558880
WHATSAPP_ACCESS_TOKEN=EAANIV... (from Meta Dashboard)
WHATSAPP_VERIFY_TOKEN=my_secret_token (set in your Meta Webhook settings)
WHATSAPP_APP_SECRET=your_app_secret (from Meta App Basic Settings)
```

## 🛠️ Usage

### 1. Verification
Meta requires a `GET` request to your `/webhook` with a specific challenge token to verify your server. This is handled by:
`GET http://localhost:3000/api/whatsapp/webhook`

### 2. Events (POST Webhook)
Incoming messages, delivery statuses, and read receipts from Meta will be sent to:
`POST http://localhost:3000/api/whatsapp/webhook`

### 3. Send Dynamic Template (POST /send-template)
**Endpoint**: `POST /api/whatsapp/send-template`

**Payload Example**:
```json
{
  "to": "919304220627",
  "template": "hello_world",
  "language": "en_US",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "Variable Content" }
      ]
    }
  ]
}
```

## 📦 Run Locally
1. **Install dependencies**: `npm install`
2. **Start the server**: `node index.js`
3. **Expose to external network**: (Optional) Use a tool like **ngrok** to get a public URL for Meta to reach your local server.
   `ngrok http 3000`
