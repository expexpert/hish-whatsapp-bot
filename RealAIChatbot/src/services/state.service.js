const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../.user_states.json');
let userStates = new Map();

/**
 * State Management with Local File Persistence
 * Ensures drafts survive server restarts
 */
class StateService {
    constructor() {
        this.loadState();
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                userStates = new Map(Object.entries(data));
            }
        } catch (e) {
            console.error("Failed to load states:", e);
            userStates = new Map();
        }
    }

    saveState() {
        try {
            const obj = Object.fromEntries(userStates);
            fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
        } catch (e) {
            console.error("Failed to save states:", e);
        }
    }

    setUserState(phoneNumber, state, data = {}) {
        const currentState = this.getUserState(phoneNumber);
        const mergedData = { ...data };
        
        if (currentState.data && currentState.data.languageChosen) {
            mergedData.languageChosen = true;
        }
        
        userStates.set(phoneNumber, { state, data: mergedData, lang: currentState.lang || 'fr' });
        this.saveState();
    }

    updateDraft(phoneNumber, draftUpdate, overwrite = false) {
        const stateObj = this.getUserState(phoneNumber);
        const currentDraft = (overwrite) ? {} : (stateObj.data.draft || {});
        stateObj.data.draft = { ...currentDraft, ...draftUpdate };
        
        userStates.set(phoneNumber, stateObj);
        this.saveState();
    }

    getDraft(phoneNumber) {
        const stateObj = this.getUserState(phoneNumber);
        return stateObj.data.draft || null;
    }

    getUserState(phoneNumber) {
        return userStates.get(phoneNumber) || { state: 'IDLE', data: {}, lang: 'fr' };
    }

    clearUserState(phoneNumber) {
        const currentState = this.getUserState(phoneNumber);
        const data = {};
        if (currentState.data && currentState.data.languageChosen) {
            data.languageChosen = true;
        }
        userStates.set(phoneNumber, { state: 'IDLE', data, lang: currentState.lang || 'fr' });
        this.saveState();
    }
    setLanguage(phoneNumber, lang) {
        const stateObj = this.getUserState(phoneNumber);
        stateObj.lang = lang;
        userStates.set(phoneNumber, stateObj);
        this.saveState();
    }
}

module.exports = new StateService();
