import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test-key';

const { app } = await import('../src/server.js');
const nativeFetch = globalThis.fetch;

const postChat = async (url, message, sourcingState = null, withImage = false) => {
  const form = new FormData();
  form.append('message', message);
  form.append('history', '[]');
  if (sourcingState) form.append('sourcingState', JSON.stringify(sourcingState));
  if (withImage) form.append('image', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'product.png');
  return nativeFetch(url, { method: 'POST', body: form });
};

test('Shopping Chat preserves the active-product path and collects missing-product sourcing fields', async (t) => {
  const server = app.listen(0);
  t.after(() => {
    globalThis.fetch = nativeFetch;
    server.close();
  });
  let answerCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const instruction = request.systemInstruction.parts[0].text;
    const planner = {
      language: 'English', intent: 'product_search', human_handoff: false,
      requires_retrieval: true, broad_category: false, retrieval_query: '',
      category: '', action: '', needs_clarification: false
    };
    if (instruction.includes('intent and retrieval planner')) {
      const plannerInput = JSON.parse(request.contents[0].parts[0].text);
      const hasImage = request.contents[0].parts.some((part) => part.inlineData);
      planner.human_handoff = /talk to a human/i.test(plannerInput.message);
      planner.retrieval_query = hasImage
        ? plannerInput.message.includes('existing') ? 'Modular travel carry-on' : 'stainless steel hot cold mug'
        : plannerInput.message.includes('Modular travel carry-on') ? 'Modular travel carry-on' : 'baby cycles';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(planner) }] } }] }), { status: 200 });
    }
    answerCalls += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Here is the product.', product_ids: ['p1'] }) }] } }] }), { status: 200 });
  };

  const url = `http://127.0.0.1:${server.address().port}/api/shopping-chat`;
  const existingResponse = await postChat(url, 'Do you have Modular travel carry-on?');
  const existingResult = await existingResponse.json();
  assert.equal(existingResponse.status, 200);
  assert.equal(existingResult.reply, 'Here is the product.');
  assert.equal(existingResult.products[0].id, 'p1');
  assert.equal(existingResult.sourcingState, undefined);
  assert.equal(answerCalls, 1);

  const existingImageResponse = await postChat(url, 'existing product image', null, true);
  const existingImageResult = await existingImageResponse.json();
  assert.equal(existingImageResponse.status, 200);
  assert.equal(existingImageResult.reply, 'Here is the product.');
  assert.equal(existingImageResult.products[0].id, 'p1');
  assert.equal(existingImageResult.sourcingState, undefined);
  assert.equal(answerCalls, 2);

  const missingImageResponse = await postChat(url, '', null, true);
  const missingImageResult = await missingImageResponse.json();
  assert.equal(missingImageResponse.status, 200);
  assert.match(missingImageResult.reply, /happy to source stainless steel hot cold mug/i);
  assert.match(missingImageResult.reply, /name/i);
  assert.ok(missingImageResult.sourcingState);
  assert.equal(answerCalls, 2, 'an unmatched image should use the existing sourcing flow instead of generic image recognition');

  const missingResponse = await postChat(url, 'I want 500 baby cycles, my name is Ali and my budget is $100 each.');
  const missingResult = await missingResponse.json();
  assert.equal(missingResponse.status, 200);
  assert.match(missingResult.reply, /happy to source baby cycles/i);
  assert.doesNotMatch(missingResult.reply, /couldn't find|can't find/i);
  assert.match(missingResult.reply, /phone number/i);
  assert.equal(missingResult.sourcingState.fields.quantity, '500');
  assert.equal(missingResult.sourcingState.fields.customerName, 'Ali');
  assert.equal(missingResult.sourcingState.fields.targetPrice, '$100');
  assert.equal(answerCalls, 2, 'missing products must start sourcing without calling the normal answer generator');

  const nextResponse = await postChat(url, '+1 (234) 567-8901', missingResult.sourcingState);
  const nextResult = await nextResponse.json();
  assert.match(nextResult.reply, /email address/i);
  assert.equal(nextResult.sourcingState.fields.phoneNumber, '+1 (234) 567-8901');
  assert.equal(answerCalls, 2);

  const handoffResponse = await postChat(url, 'I want to talk to a human.', nextResult.sourcingState);
  const handoffResult = await handoffResponse.json();
  assert.equal(handoffResult.humanHandoff, true);
});