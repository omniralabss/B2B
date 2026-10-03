import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';

const mongoose = (await import('mongoose')).default;
const nodemailer = (await import('nodemailer')).default;
const { OAuth2Client } = await import('google-auth-library');
const originalCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'test-message' }) });
const { app, Customer, CustomerSession, CustomerSignupVerification, Employee } = await import('../src/server.js');
nodemailer.createTransport = originalCreateTransport;

const originalReadyState = mongoose.connection.readyState;
beforeEach(() => {
  mongoose.connection.readyState = 1;
  mongoose.connection.emit('connected');
});
after(() => {
  mongoose.connection.readyState = originalReadyState;
  mongoose.connection.emit('disconnected');
});

const hashPassword = (password) => crypto.scryptSync(password, process.env.PASSWORD_SALT || 'omni-dev-salt', 64).toString('hex');
const queryResult = (value) => ({ select() { return this; }, lean: async () => value });
const replaceMethods = (model, replacements) => {
  const originals = Object.fromEntries(Object.keys(replacements).map((name) => [name, model[name]]));
  Object.assign(model, replacements);
  return () => Object.assign(model, originals);
};
const startServer = async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
};
const postJson = (baseUrl, endpoint, body) => fetch(`${baseUrl}${endpoint}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const stubGoogleVerifier = (t, payload) => {
  const originalVerifier = OAuth2Client.prototype.verifyIdToken;
  OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => payload });
  t.after(() => { OAuth2Client.prototype.verifyIdToken = originalVerifier; });
};
const setTestGoogleSecrets = (t) => {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_SIGNUP_TOKEN_SECRET'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.GOOGLE_CLIENT_ID = 'auth-reliability-test-client';
  process.env.GOOGLE_SIGNUP_TOKEN_SECRET = 'auth-reliability-test-signup-secret';
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
};

test('employee login preserves valid and invalid credential responses', async (t) => {
  const passwordHash = hashPassword('EmployeePass123!');
  t.after(replaceMethods(Employee, {
    findOne: () => queryResult({ _id: 'employee-1', fullName: 'Test Employee', emailAddress: 'employee@example.com', designation: 'Admin', password: passwordHash })
  }));
  const baseUrl = await startServer(t);

  const validResponse = await postJson(baseUrl, '/api/auth/login', { emailAddress: 'employee@example.com', password: 'EmployeePass123!' });
  assert.equal(validResponse.status, 200);
  const validBody = await validResponse.json();
  assert.ok(validBody.token);
  assert.equal(validBody.employee.emailAddress, 'employee@example.com');

  const invalidResponse = await postJson(baseUrl, '/api/auth/login', { emailAddress: 'employee@example.com', password: 'wrong-password' });
  assert.equal(invalidResponse.status, 401);
  assert.deepEqual(await invalidResponse.json(), { message: 'Invalid employee credentials' });
});

test('customer login preserves valid and invalid credential responses and creates a session', async (t) => {
  const passwordHash = hashPassword('CustomerPass123!');
  let createdSession = false;
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult({ _id: 'customer-1', customerName: 'Test Customer', phoneNumber: '+1234567890', emailAddress: 'customer@example.com', role: 'CUSTOMER', password: passwordHash })
  }));
  t.after(replaceMethods(CustomerSession, {
    create: async (session) => { createdSession = true; return { _id: 'session-1', ...session }; },
    updateMany: async () => ({ modifiedCount: 1 }),
    deleteOne: async () => ({ deletedCount: 1 })
  }));
  const baseUrl = await startServer(t);

  const validResponse = await postJson(baseUrl, '/api/customer-auth/login', { emailAddress: 'customer@example.com', password: 'CustomerPass123!' });
  assert.equal(validResponse.status, 200);
  assert.ok((await validResponse.json()).customer);
  assert.match(validResponse.headers.get('set-cookie') || '', /omni_customer_session=/);
  assert.equal(createdSession, true);

  const invalidResponse = await postJson(baseUrl, '/api/customer-auth/login', { emailAddress: 'customer@example.com', password: 'wrong-password' });
  assert.equal(invalidResponse.status, 401);
  assert.deepEqual(await invalidResponse.json(), { message: 'Invalid customer credentials' });
});

test('malformed stored hashes return invalid credentials instead of throwing', async (t) => {
  t.after(replaceMethods(Employee, {
    findOne: () => queryResult({ _id: 'employee-bad-hash', emailAddress: 'bad-hash@example.com', password: '$2b$12$legacy-bcrypt-hash' })
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/auth/login', { emailAddress: 'bad-hash@example.com', password: 'any-password' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: 'Invalid employee credentials' });
});

test('transient database login failures are classified and logged without credentials', async (t) => {
  const password = 'EmployeePass123!';
  const passwordHash = hashPassword(password);
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  t.after(() => { console.error = originalConsoleError; });
  t.after(replaceMethods(Employee, {
    findOne: () => ({
      select() { return this; },
      lean: async () => {
        const error = new Error('simulated server selection failure');
        error.name = 'MongoServerSelectionError';
        throw error;
      }
    })
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/auth/login', { emailAddress: 'employee@example.com', password });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: 'Database is temporarily unavailable', retryable: true });
  const diagnostic = JSON.stringify(logCalls);
  assert.match(diagnostic, /POST \/api\/auth\/login/);
  assert.match(diagnostic, /employee_lookup/);
  assert.match(diagnostic, /database_transient/);
  assert.match(diagnostic, /MongoServerSelectionError/);
  assert.doesNotMatch(diagnostic, new RegExp(password));
  assert.doesNotMatch(diagnostic, new RegExp(passwordHash));
});

test('customer session write failures are diagnosed without logging credentials and roll back a new session', async (t) => {
  const password = 'CustomerPass123!';
  const passwordHash = hashPassword(password);
  let removedSession = false;
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  t.after(() => { console.error = originalConsoleError; });
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult({ _id: 'customer-2', customerName: 'Test Customer', phoneNumber: '+1234567890', emailAddress: 'session-failure@example.com', role: 'CUSTOMER', password: passwordHash })
  }));
  t.after(replaceMethods(CustomerSession, {
    create: async (session) => ({ _id: 'session-to-rollback', ...session }),
    updateMany: async () => { throw new Error('simulated session revocation failure'); },
    deleteOne: async () => { removedSession = true; return { deletedCount: 1 }; }
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/customer-auth/login', { emailAddress: 'session-failure@example.com', password });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'Unable to sign in' });
  assert.equal(removedSession, true);
  const diagnostic = JSON.stringify(logCalls);
  assert.match(diagnostic, /customer_session_revoke_existing/);
  assert.match(diagnostic, /Error/);
  assert.doesNotMatch(diagnostic, new RegExp(password));
  assert.doesNotMatch(diagnostic, new RegExp(passwordHash));
});

test('customer session creation failures are diagnosed without attempting to revoke existing sessions', async (t) => {
  const password = 'CustomerPass123!';
  const passwordHash = hashPassword(password);
  let revocationAttempted = false;
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  t.after(() => { console.error = originalConsoleError; });
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult({ _id: 'customer-3', customerName: 'Test Customer', phoneNumber: '+1234567890', emailAddress: 'session-create-failure@example.com', role: 'CUSTOMER', password: passwordHash })
  }));
  t.after(replaceMethods(CustomerSession, {
    create: async () => { throw new Error('simulated session insert failure'); },
    updateMany: async () => { revocationAttempted = true; return { modifiedCount: 1 }; }
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/customer-auth/login', { emailAddress: 'session-create-failure@example.com', password });
  assert.equal(response.status, 500);
  assert.equal(revocationAttempted, false);
  const diagnostic = JSON.stringify(logCalls);
  assert.match(diagnostic, /customer_session_create/);
  assert.doesNotMatch(diagnostic, new RegExp(password));
  assert.doesNotMatch(diagnostic, new RegExp(passwordHash));
});

test('signup verification still creates a customer session', async (t) => {
  const signupId = 'a'.repeat(48);
  const code = '123456';
  const originalSecret = process.env.PASSWORD_RESET_SECRET;
  process.env.PASSWORD_RESET_SECRET = 'auth-reliability-test-secret';
  t.after(() => {
    if (originalSecret === undefined) delete process.env.PASSWORD_RESET_SECRET;
    else process.env.PASSWORD_RESET_SECRET = originalSecret;
  });
  const codeHash = crypto.createHmac('sha256', process.env.PASSWORD_RESET_SECRET).update(`${signupId}:${code}`).digest('hex');
  const pending = {
    _id: signupId,
    customerName: 'Signup Tester',
    phoneNumber: '+1234567890',
    emailAddress: 'signup@example.com',
    password: hashPassword('SignupPass123!'),
    codeHash,
    attempts: 0
  };
  const createdCustomer = { _id: 'signup-customer', ...pending, role: 'CUSTOMER', status: 'Active' };
  t.after(replaceMethods(CustomerSignupVerification, {
    findOne: () => queryResult(pending),
    findOneAndUpdate: () => queryResult(pending),
    updateOne: async () => ({ modifiedCount: 1 })
  }));
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult(null),
    create: async () => ({ toObject: () => createdCustomer })
  }));
  t.after(replaceMethods(CustomerSession, {
    create: async (session) => ({ _id: 'signup-session', ...session }),
    updateMany: async () => ({ modifiedCount: 0 })
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/customer-auth/signup/verify', { signupId, code });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).customer.emailAddress, 'signup@example.com');
  assert.match(response.headers.get('set-cookie') || '', /omni_customer_session=/);
});

test('signup request stores a verification and sends through the test transport', async (t) => {
  const envKeys = ['PASSWORD_RESET_SECRET', 'SMTP_HOST', 'SMTP_USER', 'SMTP_APP_PASSWORD'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    PASSWORD_RESET_SECRET: 'auth-reliability-test-secret',
    SMTP_HOST: 'smtp.test.invalid',
    SMTP_USER: 'test@example.com',
    SMTP_APP_PASSWORD: 'test-only-password'
  });
  t.after(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  let savedVerification;
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult(null)
  }));
  t.after(replaceMethods(CustomerSignupVerification, {
    deleteMany: async () => ({ deletedCount: 0 }),
    create: async (verification) => { savedVerification = verification; return verification; },
    deleteOne: async () => ({ deletedCount: 1 })
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/customer-auth/signup/request', {
    customerName: 'Signup Request Tester',
    phoneNumber: '+1234567890',
    emailAddress: 'signup-request@example.com',
    password: 'SignupPass123!',
    confirmPassword: 'SignupPass123!'
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.signupId, /^[a-f0-9]{48}$/);
  assert.equal(savedVerification._id, result.signupId);
  assert.equal(savedVerification.emailAddress, 'signup-request@example.com');
  assert.ok(savedVerification.codeHash);
});

test('Google sign-in keeps the existing customer session flow', async (t) => {
  setTestGoogleSecrets(t);
  stubGoogleVerifier(t, { sub: 'google-sub-1', email: 'google@example.com', email_verified: true, name: 'Google Customer' });
  const googleCustomer = { _id: 'google-customer-1', customerName: 'Google Customer', phoneNumber: '+1234567890', emailAddress: 'google@example.com', role: 'CUSTOMER', status: 'Active' };
  let lookupCalls = 0;
  t.after(replaceMethods(Customer, {
    findOne: () => {
      lookupCalls += 1;
      if (lookupCalls === 1) return {
        lean: async () => {
          setTimeout(() => {
            mongoose.connection.readyState = 1;
            mongoose.connection.emit('reconnected');
          }, 25);
          throw Object.assign(new Error('simulated connection drop during customer lookup'), { name: 'MongoNetworkError' });
        }
      };
      return queryResult(googleCustomer);
    }
  }));
  let sessionCreateCalls = 0;
  t.after(replaceMethods(CustomerSession, {
    create: async (session) => {
      sessionCreateCalls += 1;
      if (sessionCreateCalls === 1) {
        setTimeout(() => {
          mongoose.connection.readyState = 1;
          mongoose.connection.emit('reconnected');
        }, 25);
        throw Object.assign(new Error('simulated connection drop during session creation'), { name: 'MongoNotConnectedError' });
      }
      return { _id: `google-session-${sessionCreateCalls}`, ...session };
    },
    updateMany: async () => ({ modifiedCount: 0 })
  }));
  const baseUrl = await startServer(t);

  const response = await postJson(baseUrl, '/api/customer-auth/google', { credential: 'test-google-credential', intent: 'signin' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).customer.emailAddress, 'google@example.com');
  assert.match(response.headers.get('set-cookie') || '', /omni_customer_session=/);
  const repeatedResponse = await postJson(baseUrl, '/api/customer-auth/google', { credential: 'test-google-credential', intent: 'signin' });
  assert.equal(repeatedResponse.status, 200);
  assert.equal((await repeatedResponse.json()).customer.emailAddress, 'google@example.com');
  assert.equal(lookupCalls, 3);
  assert.equal(sessionCreateCalls, 3);
});

test('Google signup continues through phone completion and customer session creation', async (t) => {
  setTestGoogleSecrets(t);
  stubGoogleVerifier(t, { sub: 'google-sub-2', email: 'new-google@example.com', email_verified: true, name: 'New Google Customer' });
  const createdCustomer = { _id: 'google-signup-customer', customerName: 'New Google Customer', phoneNumber: '+1234567890', emailAddress: 'new-google@example.com', role: 'CUSTOMER', status: 'Active' };
  let customerCreateCalls = 0;
  t.after(replaceMethods(Customer, {
    findOne: () => queryResult(null),
    create: async () => {
      customerCreateCalls += 1;
      if (customerCreateCalls === 1) {
        setTimeout(() => {
          mongoose.connection.readyState = 1;
          mongoose.connection.emit('reconnected');
        }, 25);
        throw Object.assign(new Error('simulated connection drop during customer creation'), { name: 'MongoNetworkError' });
      }
      return { toObject: () => createdCustomer };
    }
  }));
  t.after(replaceMethods(CustomerSession, {
    create: async (session) => ({ _id: 'google-signup-session', ...session }),
    updateMany: async () => ({ modifiedCount: 0 })
  }));
  const baseUrl = await startServer(t);

  const startResponse = await postJson(baseUrl, '/api/customer-auth/google', { credential: 'test-google-credential', intent: 'signup' });
  assert.equal(startResponse.status, 200);
  const startBody = await startResponse.json();
  assert.equal(startBody.requiresPhone, true);
  assert.ok(startBody.googleSignupToken);

  const completeResponse = await postJson(baseUrl, '/api/customer-auth/google/complete', {
    googleSignupToken: startBody.googleSignupToken,
    phoneNumber: '+1234567890',
    agreedTerms: true
  });
  assert.equal(completeResponse.status, 201);
  assert.equal((await completeResponse.json()).customer.emailAddress, 'new-google@example.com');
  assert.match(completeResponse.headers.get('set-cookie') || '', /omni_customer_session=/);
  assert.equal(customerCreateCalls, 2);
});

test('signup validation and Google configuration errors retain their existing responses', async (t) => {
  const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = '';
  t.after(() => {
    if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
  });
  const baseUrl = await startServer(t);

  const signupResponse = await postJson(baseUrl, '/api/customer-auth/signup/request', {});
  assert.equal(signupResponse.status, 400);
  assert.deepEqual(await signupResponse.json(), { message: 'Complete all customer fields' });

  const googleResponse = await postJson(baseUrl, '/api/customer-auth/google', { credential: 'not-used', intent: 'signin' });
  assert.equal(googleResponse.status, 400);
  assert.deepEqual(await googleResponse.json(), { message: 'Google sign-in is not configured' });
});