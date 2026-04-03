const userStates = new Map();

/**
 * State keys for individual phone numbers
 * e.g., 'AWAITING_EXPENSE_CONFIRMATION'
 */
class StateService {
  setUserState(phoneNumber, state, data = {}) {
    userStates.set(phoneNumber, { state, data });
  }

  getUserState(phoneNumber) {
    return userStates.get(phoneNumber) || { state: 'IDLE', data: {} };
  }

  clearUserState(phoneNumber) {
    userStates.delete(phoneNumber);
  }
}

module.exports = new StateService();
