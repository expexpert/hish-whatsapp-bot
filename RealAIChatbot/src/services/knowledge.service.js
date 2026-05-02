const laravelService = require('./laravel.service.js');

class KnowledgeService {
    async getUserKnowledge(phone) {
        try {
            return await laravelService.getKnowledgeSnapshot(phone);
        } catch (error) {
            console.error("Knowledge Error:", error);
            return null;
        }
    }

    /**
     * ULTRA-COMPRESSION: 
     * We convert raw JSON to a shorthand format to save ~60% on AI token costs.
     * We now include IDs to prevent confusion between similar transactions.
     */
    formatForAI(knowledge) {
        if (!knowledge) return "[]";

        const compressed = {
            n: knowledge.business_name,
            cl: knowledge.top_clients?.map(c => ({ i: c.id, n: c.name, v: c.total })),
            sp: knowledge.top_suppliers?.map(s => ({ i: s.id, n: s.name, v: s.total })),
            tx: knowledge.taxes?.map(t => ({ i: t.i, n: t.n, r: t.r })),
            cat: knowledge.categories?.map(c => ({ i: c.i, n: c.n })),
            // rcnt = recent activity: { id: ID, t: type, e: entity, v: value, d: date }
            rcnt: (knowledge.recent || []).map(r => ({
                id: r.id, // Added ID for precision
                t: r.type[0], 
                e: r.entity,
                v: r.amount,
                d: r.date
            })),
            p: {
                rc: knowledge.summary?.rev_cur || 0,
                rp: knowledge.summary?.rev_prev || 0,
                ec: knowledge.summary?.exp_cur || 0,
                ep: knowledge.summary?.exp_prev || 0
            }
        };

        return JSON.stringify(compressed);
    }
}

module.exports = new KnowledgeService();
