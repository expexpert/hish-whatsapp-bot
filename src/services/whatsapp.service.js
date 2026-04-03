const axios = require('axios');
const config = require('../config');

class WhatsAppService {
  constructor() {
    this.baseUrl = config.whatsapp.baseUrl;
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.accessToken = config.whatsapp.accessToken;
  }

  /**
   * Generic method to send any template message
   * @param {string} to - Recipient phone number
   * @param {string} templateName - Name of the Meta-approved template
   * @param {string} languageCode - Language code, e.g., 'en_US'
   * @param {Array} components - Array of components for the template (header, body, buttons)
   */
  async sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode
        },
        components: components
      }
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('WhatsApp API Error:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

  /**
   * Method for quick "Hello World" or simple templates
   */
  async sendSimpleTemplate(to, name = 'hello_world') {
    return this.sendTemplate(to, name, 'en_US');
  }

  /**
   * Method for sending text messages (not templates)
   * Note: This only works if you have an active 24h window
   */
  async sendTextMessage(to, text) {
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      const payload = {
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: text }
      };
      const response = await axios.post(url, payload, {
          headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json'
          }
      });
      return response.data;
  }

  /**
   * Send WhatsApp Interactive Buttons (Standard, not template)
   * @param {string} to - Recipient phone number
   * @param {string} bodyText - The text for the message body
   * @param {Array} buttons - Array of button objects {id, title}
   */
  async sendInteractiveButtons(to, bodyText, buttons) {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(btn => ({
            type: 'reply',
            reply: {
              id: btn.id,
              title: btn.title
            }
          }))
        }
      }
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('WhatsApp Interactive Button Error:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

  /**
   * Send WhatsApp Interactive List (Up to 10 rows)
   * @param {string} to - Recipient phone number
   * @param {string} bodyText - The text for the message body
   * @param {string} buttonText - The text for the list button (e.g., "Options")
   * @param {Array} sections - Array of sections {title, rows: [{id, title, description}]}
   */
  async sendInteractiveList(to, bodyText, buttonText, sections) {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText,
          sections: sections
        }
      }
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('WhatsApp Interactive List Error:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}


module.exports = new WhatsAppService();
