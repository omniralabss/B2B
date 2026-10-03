import test from 'node:test';
import assert from 'node:assert/strict';

import { createSourcingState, formatSourcingContactMessage, hasRelevantActiveProduct, nextSourcingField, parseTargetPrice, sourcingQuestion, updateSourcingState } from '../src/sourcingRequest.js';

test('sourcing intake retains multiple fields and skips questions already answered', () => {
  const state = createSourcingState({
    requestId: 'request-1',
    product: 'baby cycles',
    message: 'I want 500 baby cycles, my name is Ali and my budget is $100 each.'
  });

  assert.equal(state.fields.product, 'baby cycles');
  assert.equal(state.fields.quantity, '500');
  assert.equal(state.fields.customerName, 'Ali');
  assert.equal(state.fields.targetPrice, '$100');
  assert.equal(state.askedField, 'phoneNumber');
  assert.equal(sourcingQuestion(state.askedField), 'What phone number should our vendors use to reach you?');
});

test('sourcing intake captures later answers and uses the latest explicit value', () => {
  let state = createSourcingState({ requestId: 'request-2', product: 'phone covers', message: 'I need phone covers.' });
  assert.equal(state.askedField, 'customerName');
  state = updateSourcingState(state, 'Ali');
  assert.equal(state.askedField, 'quantity');
  state = updateSourcingState(state, '500 units');
  assert.equal(state.fields.quantity, '500 units');
  state = updateSourcingState(state, 'Actually, 750 units');
  assert.equal(state.fields.quantity, '750 units');
  assert.equal(nextSourcingField(state.fields), 'targetPrice');
});

test('sourcing intake extracts several fields from a single follow-up answer', () => {
  let state = createSourcingState({ requestId: 'request-3', product: 'phone covers', message: 'I need phone covers.' });
  state = updateSourcingState(state, 'Ali, 500 units, $2 each, +1 (234) 567-8901, ali@example.com');

  assert.equal(state.fields.customerName, 'Ali');
  assert.equal(state.fields.quantity, '500 units');
  assert.equal(state.fields.targetPrice, '$2');
  assert.equal(state.fields.phoneNumber, '+1 (234) 567-8901');
  assert.equal(state.fields.email, 'ali@example.com');
  assert.equal(state.askedField, null);
});

test('target price preserves stated currencies and defaults bare numbers to USDT', () => {
  assert.equal(parseTargetPrice('5.2 USDT', true), '5.2 USDT');
  assert.equal(parseTargetPrice('200 PKR', true), '200 PKR');
  assert.equal(parseTargetPrice('$5', true), '$5');
  assert.equal(parseTargetPrice('5.3 USD', true), '5.3 USD');
  assert.equal(parseTargetPrice('5.3', true), '5.3 USDT');
  assert.equal(parseTargetPrice('budget is 5.2 USDT each', false), '5.2 USDT');
});

test('product specifications exclude the customer name, contact details, and price', () => {
  const state = createSourcingState({
    requestId: 'request-4',
    product: 'phone cover',
    message: 'I need 500 waterproof phone covers for iPhone 15, my name is Ali and my budget is 5.2 USDT each.'
  });

  assert.equal(state.fields.quantity, '500');
  assert.equal(state.fields.customerName, 'Ali');
  assert.equal(state.fields.targetPrice, '5.2 USDT');
  assert.equal(state.details, 'waterproof iPhone 15');
});

test('Contact Request message contains only clean labeled sourcing lines', () => {
  assert.equal(
    formatSourcingContactMessage({ product: 'Phone Cover', quantity: '500', targetPrice: '5.2 USDT' }),
    'Product: Phone Cover\nMOQ: 500 units\nTarget price: 5.2 USDT per unit'
  );
  assert.equal(
    formatSourcingContactMessage({ product: 'Phone Cover', quantity: '500 units', targetPrice: '200 PKR', details: 'waterproof, iPhone 15' }),
    'Product: Phone Cover\nMOQ: 500 units\nTarget price: 200 PKR per unit\nDetails: waterproof, iPhone 15'
  );
});

test('active product relevance is decided by existing product score, not mere candidates', () => {
  const score = (product, query) => product.name.toLowerCase().includes(query.toLowerCase()) ? 700 : product.score;
  assert.equal(hasRelevantActiveProduct([{ name: 'Baby Nursery Set', score: 50 }], 'baby cycle', score), false);
  assert.equal(hasRelevantActiveProduct([{ name: 'Baby Cycle', score: 0 }], 'baby cycle', score), true);
});