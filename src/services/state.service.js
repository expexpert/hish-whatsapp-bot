const userStates = new Map();
const authCache = new Map();

/**
 * State keys for individual phone numbers
 * e.g., 'AWAITING_EXPENSE_CONFIRMATION'
 */
class StateService {
  setUserState(phoneNumber, state, data = {}) {
    const currentState = this.getUserState(phoneNumber);
    userStates.set(phoneNumber, { state, data, lang: currentState.lang || 'en' });
  }

  getUserState(phoneNumber) {
    return userStates.get(phoneNumber) || { state: 'IDLE', data: {}, lang: 'en' };
  }

  setLanguage(phoneNumber, lang) {
    const state = this.getUserState(phoneNumber);
    state.lang = lang;
    userStates.set(phoneNumber, state);
  }

  clearUserState(phoneNumber) {
    const currentState = this.getUserState(phoneNumber);
    userStates.set(phoneNumber, { state: 'IDLE', data: {}, lang: currentState.lang || 'en' });
  }

  // --- Auth Cache (Solves Rate Limiting) ---
  setAuthStatus(phoneNumber, isAuth) {
    authCache.set(phoneNumber, {
      isAuth,
      expiresAt: Date.now() + (10 * 60 * 1000) // 10 minutes cache
    });
  }

  getAuthStatus(phoneNumber) {
    const cached = authCache.get(phoneNumber);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.isAuth;
    }
    return null; // Cache miss or expired
  }

  // --- Negative Cache (30s Back-off for failures) ---
  setBlockedStatus(phoneNumber) {
    authCache.set(phoneNumber, {
      isAuth: false,
      isBlocked: true,
      expiresAt: Date.now() + 30000 // 30 seconds back-off
    });
  }

  isBlocked(phoneNumber) {
    const cached = authCache.get(phoneNumber);
    return cached && cached.isBlocked && cached.expiresAt > Date.now();
  }
}

module.exports = new StateService();
