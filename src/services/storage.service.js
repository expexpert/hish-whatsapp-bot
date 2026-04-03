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

    // 1. Get the Download URL from Meta
    const urlResponse = await axios.get(`${config.whatsapp.baseUrl}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${config.whatsapp.accessToken}` }
    });
    
    const downloadUrl = urlResponse.data.url;

    // 2. Download the binary content
    const fileResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: { 'Authorization': `Bearer ${config.whatsapp.accessToken}` }
    });

    // 3. Save to file
    fs.writeFileSync(filePath, fileResponse.data);
    return filePath;
  }
}

module.exports = new StorageService();
