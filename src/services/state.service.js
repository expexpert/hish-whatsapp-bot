const userStates = new Map();
const authCache = new Map();

/**
 * State keys for individual phone numbers
 * e.g., 'AWAITING_EXPENSE_CONFIRMATION'
 */
class StateService {
  setUserState(phoneNumber, state, data = {}) {
    const currentState = this.getUserState(phoneNumber);
    const mergedData = { ...data };
    
    // Critically preserve the languageChosen flag across ALL state transitions
    if (currentState.data && currentState.data.languageChosen) {
        mergedData.languageChosen = true;
    }
    
    userStates.set(phoneNumber, { state, data: mergedData, lang: currentState.lang || 'fr' });
  }

  getUserState(phoneNumber) {
    const state = userStates.get(phoneNumber) || { state: 'IDLE', data: {}, lang: 'fr' };
    return state;
  }

  setLanguage(phoneNumber, lang, pushToDb = true) {
    const state = this.getUserState(phoneNumber);
    state.lang = lang;
    userStates.set(phoneNumber, state);
    
    // We don't import laravelService here to avoid circular dependency
    // Instead, the controller handles the DB push if needed, 
    // or we can pass a callback. For now, since the controller calls this,
    // we just update the memory state.
  }

  clearUserState(phoneNumber) {
    const currentState = this.getUserState(phoneNumber);
    const data = {};
    
    // Preserve session flags
    if (currentState.data && currentState.data.languageChosen) {
        data.languageChosen = true;
    }
    
    userStates.set(phoneNumber, { state: 'IDLE', data, lang: currentState.lang || 'fr' });
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
