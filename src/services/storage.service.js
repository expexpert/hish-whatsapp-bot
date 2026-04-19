const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class StorageService {
  /**
   * Download a file from Meta Media API and store it locally
   */
  async downloadMedia(mediaId, fileName) {
    const storageDir = config.storageDir;
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const filePath = path.join(storageDir, fileName);

    try {
      // 1. Get the Download URL from Meta
      const urlResponse = await axios.get(`${config.whatsapp.baseUrl}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${config.whatsapp.accessToken}` }
      });
      
      const downloadUrl = urlResponse.data.url;
      if (!downloadUrl) throw new Error("Meta API did not return a download URL");

      // 2. Download the binary content
      const fileResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        headers: { 'Authorization': `Bearer ${config.whatsapp.accessToken}` }
      });

      // 3. Save to file
      fs.writeFileSync(filePath, fileResponse.data);
      return filePath;
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`❌ [StorageService] Failed to download media ${mediaId}:`, errorMsg);
      throw new Error(`Media download failed: ${errorMsg}`);
    }
  }
}

module.exports = new StorageService();
