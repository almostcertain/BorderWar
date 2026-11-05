// Creates BorderWar's products and prices in a Paddle account, from
// js/shop-defs.js (docs/monetization.md MO-6). Safe to run again: an item
// whose price already exists (tagged custom_data.borderwar_sku) is skipped.
//
//   PADDLE_API_KEY=... PADDLE_ENV=sandbox node server/accounts/paddle-setup.js
//
// A price change later is made in the Paddle dashboard: archive the old price,
// add a new one on the same product with the same custom_data.
'use strict';

const ShopDefs = require('../../js/shop-defs.js');
const paddleModule = require('./paddle');

const cents = (dollars) => String(Math.round(dollars * 100));

function items() {
  const out = [];
  for (const [sku, p] of Object.entries(ShopDefs.BB_PACKS)) {
    out.push({
      sku,
      product: { name: p.bb.toLocaleString('en-US') + ' Border Bucks', description: 'BorderWar premium currency.' },
      price: { description: '$' + p.price + ' pack', unit_price: { amount: cents(p.price), currency_code: 'USD' } }
    });
  }
  for (const [sku, t] of Object.entries(ShopDefs.TIERS)) {
    out.push({
      sku,
      product: { name: 'BorderWar ' + t.name, description: 'Monthly subscription: verified name, ' + t.monthlyBB + ' Border Bucks a month, public lobbies.' },
      price: {
        description: t.name + ' monthly',
        unit_price: { amount: cents(t.priceMonthly), currency_code: 'USD' },
        billing_cycle: { interval: 'month', frequency: 1 }
      }
    });
  }
  return out;
}

async function run(paddle, print) {
  const existing = new Set();
  for (const p of await paddle.listPrices()) {
    const sku = p.custom_data && p.custom_data.borderwar_sku;
    if (sku) existing.add(sku);
  }
  let made = 0;
  for (const it of items()) {
    if (existing.has(it.sku)) { print('  have   ' + it.sku); continue; }
    const tag = { borderwar_sku: it.sku };
    const product = await paddle.api('POST', '/products', Object.assign({ tax_category: 'standard', custom_data: tag }, it.product));
    await paddle.api('POST', '/prices', Object.assign({
      product_id: product.data.id, quantity: { minimum: 1, maximum: 1 }, custom_data: tag
    }, it.price));
    print('  made   ' + it.sku + '  (' + it.product.name + ')');
    made++;
  }
  return made;
}

async function main() {
  const env = process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
  if (!process.env.PADDLE_API_KEY) {
    console.error('Set PADDLE_API_KEY (and PADDLE_ENV=production for the live account).');
    return 2;
  }
  // `configured` needs all three keys; setup needs only the API key.
  const paddle = paddleModule.create({ apiKey: process.env.PADDLE_API_KEY, clientToken: '-', webhookSecret: '-', environment: env });
  console.log('Paddle ' + env + ':');
  const made = await run(paddle, (s) => console.log(s));
  console.log(made ? 'Done. Restart the server so it picks up the new prices.' : 'Nothing to do.');
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(e && e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { items, run };
