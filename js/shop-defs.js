// Subscription tiers and Border Bucks packs (docs/monetization.md §3, §4). Pure
// data, client-only for the sim's purposes; the Node server requires this same
// file. Tier and pack ids are stable once shipped: never rename or reuse one.
const ShopDefs = {
  // `rank` orders tiers for upgrades; `publicLobbies` is how many public
  // lobbies one subscriber may have open at once; `marksBoost` applies from MO-4.
  TIERS: {
    scout: { name: 'Scout', rank: 1, priceMonthly: 2.99, monthlyBB: 300, color: '#b8c2cc', publicLobbies: 1, marksBoost: 0 },
    warden: { name: 'Warden', rank: 2, priceMonthly: 5.99, monthlyBB: 700, color: '#e0b030', publicLobbies: 2, marksBoost: 0.25 },
    sovereign: { name: 'Sovereign', rank: 3, priceMonthly: 11.99, monthlyBB: 1600, color: '#d8463c', publicLobbies: 3, marksBoost: 0.5 }
  },

  BB_PACKS: {
    bb_5: { price: 5, bb: 500 },
    bb_10: { price: 10, bb: 1050 },
    bb_20: { price: 20, bb: 2200 },
    bb_50: { price: 50, bb: 5750 },
    bb_100: { price: 100, bb: 12000 }
  },

  // The tier's definition, or null for anything unknown (roster data is untrusted).
  tier(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.TIERS, id) ? this.TIERS[id] : null;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ShopDefs;
