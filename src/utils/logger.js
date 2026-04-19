const config = require('../config');

class Logger {
  info(message, data = null) {
    console.log(`ℹ️ [INFO] ${message}`, data ? data : '');
  }

  debug(message, data = null) {
    if (config.debug) {
      console.log(`🔍 [DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }

  warn(message, data = null) {
    console.warn(`⚠️ [WARN] ${message}`, data ? data : '');
  }

  error(message, error = null) {
    console.error(`❌ [ERROR] ${message}`, error ? (error.message || error) : '');
    if (error && error.stack && config.debug) {
      console.error(error.stack);
    }
  }
}

module.exports = new Logger();
