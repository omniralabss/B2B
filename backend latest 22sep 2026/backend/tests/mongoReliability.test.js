import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';

const { app, Category, Product, connectMongo, databaseState, readWithRetry } = await import('../src/server.js');
const originalReadyState = mongoose.connection.readyState;

beforeEach(() => {
  mongoose.connection.readyState = 1;
  mongoose.connection.emit('connected');
});
after(() => {
  mongoose.connection.readyState = originalReadyState;
  mongoose.connection.emit('disconnected');
});

const replaceMethods = (model, replacements) => {
  const originals = Object.fromEntries(Object.keys(replacements).map((name) => [name, model[name]]));
  Object.assign(model, replacements);
  return () => Object.assign(model, originals);
};
const queryResult = (value) => ({
  select() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  lean: async () => value
});
const startServer = async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
};
const withMongoUri = (t, value = 'mongodb://unit-test.invalid/vendorwoo') => {
  const original = process.env.MONGODB_URI;
  process.env.MONGODB_URI = value;
  t.after(() => {
    if (original === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = original;
  });
};

test('readiness requires both the app flag and Mongoose connected state', () => {
  assert.equal(databaseState(), true);
  mongoose.connection.readyState = 0;
  mongoose.connection.emit('disconnected');
  assert.equal(databaseState(), false);
});

test('health preserves liveness while reporting Mongo readiness', async (t) => {
  const baseUrl = await startServer(t);
  mongoose.connection.readyState = 0;
  mongoose.connection.emit('disconnected');
  const unavailableResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(unavailableResponse.status, 200);
  assert.deepEqual(await unavailableResponse.json(), { status: 'ok', service: 'omni-ra-labs-api', databaseReady: false });
  const notReadyResponse = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(notReadyResponse.status, 503);
  assert.equal(notReadyResponse.headers.get('retry-after'), '1');
  assert.deepEqual(await notReadyResponse.json(), { status: 'not_ready', service: 'omni-ra-labs-api', databaseReady: false, retryable: true });

  mongoose.connection.readyState = 1;
  mongoose.connection.emit('connected');
  const readyResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).databaseReady, true);
  const readinessResponse = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(readinessResponse.status, 200);
  assert.deepEqual(await readinessResponse.json(), { status: 'ready', service: 'omni-ra-labs-api', databaseReady: true });
});

test('concurrent Mongo connect calls share one connection attempt', async (t) => {
  withMongoUri(t);
  const originalConnect = mongoose.connect;
  let connectCalls = 0;
  mongoose.connect = async () => {
    connectCalls += 1;
    mongoose.connection.readyState = 1;
    mongoose.connection.emit('connected');
    return mongoose;
  };
  t.after(() => { mongoose.connect = originalConnect; });
  mongoose.connection.readyState = 0;
  mongoose.connection.emit('disconnected');

  const first = connectMongo();
  const second = connectMongo();
  assert.strictEqual(first, second);
  assert.equal(await first, true);
  assert.equal(connectCalls, 1);
  assert.equal(databaseState(), true);
});

test('connectMongo waits for an in-progress Mongoose connection', async (t) => {
  withMongoUri(t);
  const originalAsPromise = mongoose.connection.asPromise;
  let resolveConnection;
  mongoose.connection.asPromise = () => new Promise((resolve) => { resolveConnection = resolve; });
  t.after(() => { mongoose.connection.asPromise = originalAsPromise; });
  mongoose.connection.readyState = 2;
  mongoose.connection.emit('connecting');

  const first = connectMongo();
  const second = connectMongo();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(typeof resolveConnection, 'function');
  mongoose.connection.readyState = 1;
  resolveConnection(mongoose.connection);

  assert.equal(await first, true);
  assert.equal(databaseState(), true);
});

test('connectMongo validates a ready-state connection after it was marked unavailable', async (t) => {
  withMongoUri(t);
  const originalDatabase = mongoose.connection.db;
  let pingCalls = 0;
  mongoose.connection.db = {
    admin: () => ({
      ping: async () => {
        pingCalls += 1;
        if (pingCalls === 1) throw Object.assign(new Error('simulated stale connection'), { name: 'MongoNetworkError' });
        return { ok: 1 };
      }
    })
  };
  t.after(() => { mongoose.connection.db = originalDatabase; });
  mongoose.connection.readyState = 1;
  mongoose.connection.emit('error', new Error('simulated stale connection event'));
  assert.equal(databaseState(), false);

  await assert.rejects(connectMongo(), /simulated stale connection/);
  assert.equal(databaseState(), false);
  assert.equal(await connectMongo(), true);
  assert.equal(pingCalls, 2);
  assert.equal(databaseState(), true);
});

test('failed startup connect remains unavailable and a single scheduled reconnect restores readiness', async (t) => {
  withMongoUri(t);
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConnect = mongoose.connect;
  let connectCalls = 0;
  process.env.NODE_ENV = 'production';
  mongoose.connect = async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      mongoose.connection.readyState = 0;
      throw Object.assign(new Error('simulated unavailable server'), { name: 'MongoServerSelectionError' });
    }
    mongoose.connection.readyState = 1;
    mongoose.connection.emit('connected');
    return mongoose;
  };
  t.after(() => {
    process.env.NODE_ENV = originalNodeEnv;
    mongoose.connect = originalConnect;
    mongoose.connection.readyState = 1;
    mongoose.connection.emit('connected');
  });
  mongoose.connection.readyState = 0;
  mongoose.connection.emit('disconnected');
  const recovered = new Promise((resolve) => mongoose.connection.once('connected', resolve));

  await assert.rejects(connectMongo(), /simulated unavailable server/);
  assert.equal(databaseState(), false);
  let timeout;
  try {
    await Promise.race([
      recovered,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('reconnect timed out')), 3000); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(databaseState(), true);
  assert.equal(connectCalls, 2);
  await connectMongo();
  assert.equal(connectCalls, 2);
});

test('transient read errors retry after readiness recovers', async () => {
  let operationCalls = 0;
  const result = await readWithRetry('test-retry', async () => {
    operationCalls += 1;
    if (operationCalls === 1) {
      setTimeout(() => {
        mongoose.connection.readyState = 1;
        mongoose.connection.emit('reconnected');
      }, 25);
      throw Object.assign(new Error('simulated network loss'), { name: 'MongoNetworkError' });
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(operationCalls, 2);
  assert.equal(databaseState(), true);
});

test('product/category reads succeed with a ready Mongo connection', async (t) => {
  withMongoUri(t);
  const product = { _id: 'test-product', name: 'Test Product', title: 'Test Product', category: 'Test Category', status: 'Published', createdAt: new Date(), images: [] };
  const category = { _id: 'test-category', name: 'Test Category', slug: 'test-category', status: 'Active', createdAt: new Date() };
  t.after(replaceMethods(Product, {
    find: () => queryResult([product]),
    countDocuments: async () => 1,
    aggregate: async () => [{ _id: 'Test Category', count: 1 }]
  }));
  t.after(replaceMethods(Category, {
    find: () => queryResult([category]),
    countDocuments: async () => 1
  }));
  const baseUrl = await startServer(t);

  const productsResponse = await fetch(`${baseUrl}/api/products?limit=10&test=${Date.now()}`);
  const categoriesResponse = await fetch(`${baseUrl}/api/categories?limit=10&test=${Date.now()}`);
  assert.equal(productsResponse.status, 200);
  assert.equal((await productsResponse.json()).data.length, 1);
  assert.equal(categoriesResponse.status, 200);
  assert.equal((await categoriesResponse.json()).data.length, 1);
});

test('a drop after readiness is converted to a retryable 503, not memory fallback', async (t) => {
  withMongoUri(t);
  let productReadCalls = 0;
  t.after(replaceMethods(Product, {
    find: () => ({
      select() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => {
        productReadCalls += 1;
        mongoose.connection.readyState = 0;
        mongoose.connection.emit('disconnected');
        throw Object.assign(new Error('simulated socket drop'), { name: 'MongoNotConnectedError' });
      }
    }),
    countDocuments: async () => 1
  }));
  const baseUrl = await startServer(t);

  const response = await fetch(`${baseUrl}/api/products?test=race-${Date.now()}`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: 'Database is temporarily unavailable', retryable: true });
  assert.equal(productReadCalls, 1);
  assert.equal(databaseState(), false);
});

test('product reads return 503 when Mongo is unavailable or unconfigured', async (t) => {
  const baseUrl = await startServer(t);
  withMongoUri(t);
  mongoose.connection.readyState = 0;
  mongoose.connection.emit('disconnected');
  const unavailable = await fetch(`${baseUrl}/api/products?test=unavailable-${Date.now()}`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).retryable, true);

  delete process.env.MONGODB_URI;
  const unconfigured = await fetch(`${baseUrl}/api/products?test=unconfigured-${Date.now()}`);
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).retryable, true);
});