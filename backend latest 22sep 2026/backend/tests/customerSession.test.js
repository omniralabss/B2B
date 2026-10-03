import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';

const { app, Customer, CustomerSession } = await import('../src/server.js');

const createUniqueEmail = (prefix = 'customer') => `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;

const createTestUser = async (emailAddress = createUniqueEmail()) => {
  const existing = await Customer.findOne({ emailAddress }).lean();
  if (existing) return existing;

  const customer = await Customer.create({
    customerName: 'Session Tester',
    phoneNumber: '+1234567890',
    emailAddress,
    password: crypto.scryptSync('Password123!', process.env.PASSWORD_SALT || 'omni-dev-salt', 64).toString('hex'),
    role: 'CUSTOMER',
    status: 'Active'
  });

  return customer.toObject();
};

test('customer session persists and is invalidated on logout', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  const emailAddress = createUniqueEmail('persist_');
  const customer = await createTestUser(emailAddress);

  const loginResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/customer-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailAddress, password: 'Password123!' })
  });

  assert.equal(loginResponse.status, 200, 'login should succeed');
  const loginBody = await loginResponse.json();
  assert.ok(loginBody.customer, 'login should return customer payload');

  const cookie = loginResponse.headers.get('set-cookie') || '';
  assert.match(cookie, /omni_customer_session=/, 'login should set the customer session cookie');

  const meResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/customer-auth/me`, {
    method: 'GET',
    headers: { Cookie: cookie }
  });

  assert.equal(meResponse.status, 200, 'session should restore successfully');
  const meBody = await meResponse.json();
  assert.equal(meBody.customer.emailAddress, emailAddress);

  const logoutResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/customer-auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });

  assert.equal(logoutResponse.status, 204, 'logout should revoke the session');

  const revokedMeResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/customer-auth/me`, {
    method: 'GET',
    headers: { Cookie: cookie }
  });

  assert.equal(revokedMeResponse.status, 401, 'revoked session must be rejected');

  const storedSession = await CustomerSession.findOne({ customerId: customer._id, status: 'revoked' });
  assert.ok(storedSession, 'revoked session should remain recorded in MongoDB');
});
