const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');


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
      logger.debug(`[OUTBOUND TEMPLATE to ${to}]: ${templateName}`);
      const response = await axios.post(url, payload, {

        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
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
      logger.debug(`[OUTBOUND TEXT to ${to}]: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
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
              title: btn.title.length > 20 ? btn.title.substring(0, 17) + '...' : btn.title
            }
          }))
        }
      }
    };

    try {
      logger.debug(`[OUTBOUND BUTTONS to ${to}]: ${buttons.length} buttons`);
      const response = await axios.post(url, payload, {

        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
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
    
    // Sanitize sections to adhere to WhatsApp limits
    const sanitizedSections = sections.map(section => ({
      title: section.title ? (section.title.length > 24 ? section.title.substring(0, 21) + '...' : section.title) : undefined,
      rows: section.rows.map(row => ({
        id: row.id,
        title: row.title.length > 24 ? row.title.substring(0, 21) + '...' : row.title,
        description: row.description ? (row.description.length > 72 ? row.description.substring(0, 69) + '...' : row.description) : undefined
      }))
    }));

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText.length > 20 ? buttonText.substring(0, 17) + '...' : buttonText,
          sections: sanitizedSections
        }
      }
    };

    try {
      logger.debug(`[OUTBOUND LIST to ${to}]: "${buttonText}"`);
      const response = await axios.post(url, payload, {

        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Send a real file (PDF, etc.) as a downloadable document
   * @param {string} to - Recipient phone number
   * @param {string} url - Publicly accessible URL of the file
   * @param {string} filename - Display name for the file
   * @param {string} caption - Optional caption text
   */
  async sendDocument(to, url, filename, caption = null) {
    const apiURL = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'document',
      document: {
        link: url,
        filename: filename
      }
    };

    if (caption) {
      payload.document.caption = caption;
    }

    try {
      logger.debug(`[OUTBOUND DOCUMENT to ${to}]: ${filename}`);
      const response = await axios.post(apiURL, payload, {

        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Send a native image message
   * @param {string} to - Recipient phone number
   * @param {string} url - Publicly accessible URL of the image
   * @param {string} caption - Optional caption text
   */
  async sendImage(to, url, caption = null) {
    const apiURL = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'image',
      image: {
        link: url
      }
    };

    if (caption) {
      payload.image.caption = caption;
    }

    try {
      logger.debug(`[OUTBOUND IMAGE to ${to}]`);
      const response = await axios.post(apiURL, payload, {

        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }
}


module.exports = new WhatsAppService();
