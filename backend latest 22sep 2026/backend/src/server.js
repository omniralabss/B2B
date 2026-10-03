import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { createClient } from 'redis'
import mongoose from 'mongoose'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import nodemailer from 'nodemailer'
import { OAuth2Client } from 'google-auth-library'
import { Server as SocketServer } from 'socket.io'
import { countInquiriesByProduct, sortHotSellingProducts } from './productRanking.js'
import { createSourcingState, formatSourcingContactMessage, hasRelevantActiveProduct, nextSourcingField, sourcingEmailPattern, sourcingPhonePattern, sourcingQuestion, updateSourcingState } from './sourcingRequest.js'
import { createCommunityRouter } from './community.js'

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || (process.cwd().endsWith('backend') ? path.join(process.cwd(), '.env') : path.join(process.cwd(), 'backend', '.env')) })

const app = express()
const httpServer = http.createServer(app)
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()) : true,
    credentials: true
  }
})
io.on('connection', (socket) => {
  socket.on('disconnect', () => { })
})
app.set('trust proxy', 1)
const port = process.env.PORT || 5050
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()) : true, credentials: true }))
app.use(compression())
app.use(express.json())

const publicRateLimit = rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.PUBLIC_RATE_LIMIT) || 300, standardHeaders: 'draft-7', legacyHeaders: false })
app.use('/api/products', publicRateLimit)
app.use('/api/categories', publicRateLimit)
app.use('/api/inquiries', publicRateLimit)
app.use('/api/contact-requests', publicRateLimit)
app.use('/api/community', publicRateLimit)
const shoppingChatRateLimit = rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.SHOPPING_CHAT_RATE_LIMIT) || 30, standardHeaders: 'draft-7', legacyHeaders: false })
const passwordResetRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false })
const signupVerificationRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false })

const memoryCache = new Map()
const cacheTtl = { categories: 30_000, products: 15_000, product: 60_000 }
const redis = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1000, reconnectStrategy: false } }) : null
if (redis) redis.on('error', (error) => console.error('Redis cache error:', error.message))
const cacheKey = (prefix, value) => `marketplace:${prefix}:${value}`
const readCache = async (key) => {
  const local = memoryCache.get(key)
  if (local && local.expiresAt > Date.now()) return local.value
  if (local) memoryCache.delete(key)
  if (!redis?.isReady) return null
  const value = await redis.get(key)
  return value ? JSON.parse(value) : null
}
const writeCache = async (key, value, ttl) => {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttl })
  if (redis?.isReady) await redis.set(key, JSON.stringify(value), { PX: ttl })
}
const invalidateCache = async (prefix) => {
  for (const key of memoryCache.keys()) if (key.startsWith(`marketplace:${prefix}:`)) memoryCache.delete(key)
  if (redis?.isReady) {
    const keys = await redis.keys(`marketplace:${prefix}:*`)
    if (keys.length) await redis.del(keys)
  }
}
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
app.use('/api', async (req, res, next) => {
  if (req.method === 'GET' && (req.path.startsWith('/products') || req.path.startsWith('/categories'))) res.set('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    const resource = req.path.startsWith('/categories') ? 'categories' : req.path.startsWith('/products') ? 'products' : req.path.startsWith('/vendors') ? 'vendors' : req.path.startsWith('/customers') ? 'customers' : req.path.startsWith('/employees') ? 'employees' : null
    if (resource) {
      await invalidateCache(resource)
      if (resource === 'products') await invalidateCache('product')
    }
  }
  next()
})

const resolveUploadDirectory = () => {
  const configuredDirectory = String(process.env.UPLOADS_DIR || '').trim()
  const defaultDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
  const temporaryDirectory = path.join(os.tmpdir(), 'vendorwoo-uploads')
  const candidates = configuredDirectory && !configuredDirectory.includes('/path/to/') && !configuredDirectory.includes('\\path\\to\\')
    ? [configuredDirectory, defaultDirectory, temporaryDirectory]
    : [defaultDirectory, temporaryDirectory]
  for (const candidate of candidates) {
    const directory = path.resolve(candidate)
    try {
      fs.mkdirSync(directory, { recursive: true })
      fs.accessSync(directory, fs.constants.W_OK)
      return directory
    } catch (error) {
      console.warn(`Upload directory unavailable at ${directory}: ${error.message}`)
    }
  }
  throw new Error('No writable upload directory is available')
}
const uploadDirectory = resolveUploadDirectory()
app.use('/uploads', (req, res, next) => {
  if (req.query.media === 'audio') {
    const extension = path.extname(req.path).toLowerCase()
    res.set('Content-Type', extension === '.wav' ? 'audio/wav' : 'audio/webm; codecs=opus')
  }
  next()
}, express.static(uploadDirectory, { maxAge: '1d', immutable: true }))
const categoryImageUpload = multer({
  storage: multer.diskStorage({ destination: uploadDirectory, filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
})
const productMediaUpload = multer({
  storage: multer.diskStorage({ destination: uploadDirectory, filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 100 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => callback(null, file.fieldname === 'video' ? /^video\/(mp4|webm|quicktime)$/.test(file.mimetype) : /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
})
const chatImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) })
const messageMediaUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      /^image\//,
      /^audio\//,
      /^video\/(mp4|webm|quicktime)$/,
      /^application\/pdf$/,
      /^application\/msword$/,
      /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
      /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/,
      /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/,
      /^text\//
    ]
    callback(null, allowed.some((pattern) => pattern.test(file.mimetype)))
  }
})

const Category = mongoose.models.Category || mongoose.model('Category', new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, index: true },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
  image: { type: String, default: '/1.jpeg' }
}, { timestamps: true, collection: 'categories' }))
const Product = mongoose.models.Product || mongoose.model('Product', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  category: { type: String, required: true, index: true },
  shortDescription: { type: String, required: true, maxlength: 1000 },
  description: { type: String, default: '' },
  priceTiers: [{ price: { type: String, required: true }, moqMin: { type: Number, required: true }, moqMax: { type: Number, required: true } }],
  tiers: [{ price: String, moqMin: Number, moqMax: Number }],
  images: { type: [String], default: [] },
  image: { type: String, default: '/1.jpeg' },
  video: { type: String, default: '' },
  embedding: { type: [Number], select: false },
  status: { type: String, default: 'Published', index: true }
}, { timestamps: true, collection: 'products' }))
const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', new mongoose.Schema({
  ownerName: { type: String, required: true, trim: true, maxlength: 160 },
  registeredBusinessName: { type: String, required: true, trim: true, maxlength: 200 },
  registeredBusinessAddress: { type: String, required: true, trim: true, maxlength: 500 },
  registeredPhoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  registeredEmailAddress: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  category: { type: String, required: true, trim: true, index: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true }
}, { timestamps: true, collection: 'vendors' }))
const Customer = mongoose.models.Customer || mongoose.model('Customer', new mongoose.Schema({
  customerName: { type: String, required: true, trim: true, maxlength: 160 },
  phoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  emailAddress: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  password: { type: String, select: false },
  googleSub: { type: String, index: true, unique: true, sparse: true },
  authProvider: { type: String, enum: ['password', 'google'], default: 'password', index: true },
  role: { type: String, enum: ['CUSTOMER'], default: 'CUSTOMER', index: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true }
}, { timestamps: true, collection: 'customers' }))
const CustomerSession = mongoose.models.CustomerSession || mongoose.model('CustomerSession', new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'Customer' },
  tokenHash: { type: String, required: true, unique: true, index: true, select: false },
  status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active', index: true },
  revokedAt: { type: Date, default: null, index: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, collection: 'customer_sessions' }))
const CustomerPasswordReset = mongoose.models.CustomerPasswordReset || mongoose.model('CustomerPasswordReset', new mongoose.Schema({
  _id: { type: String },
  customerId: { type: mongoose.Schema.Types.ObjectId, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, index: true },
  accountType: { type: String, enum: ['customer', 'employee'], default: 'customer', index: true },
  emailAddress: { type: String, required: true, lowercase: true, index: true },
  codeHash: { type: String, required: true, select: false },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: null },
  usedAt: { type: Date, default: null }
}, { timestamps: true, collection: 'customer_password_resets' }))
const CustomerSignupVerification = mongoose.models.CustomerSignupVerification || mongoose.model('CustomerSignupVerification', new mongoose.Schema({
  _id: { type: String },
  customerName: { type: String, required: true, trim: true, maxlength: 160 },
  phoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  emailAddress: { type: String, required: true, lowercase: true, index: true },
  password: { type: String, required: true, select: false },
  codeHash: { type: String, required: true, select: false },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: null },
  usedAt: { type: Date, default: null }
}, { timestamps: true, collection: 'customer_signup_verifications' }))
const Employee = mongoose.models.Employee || mongoose.model('Employee', new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 160 },
  fatherName: { type: String, required: true, trim: true, maxlength: 160 },
  cnic: { type: String, required: true, trim: true, maxlength: 30 },
  phoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  emailAddress: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  password: { type: String, required: true, select: false },
  address: { type: String, required: true, trim: true, maxlength: 500 },
  designation: { type: String, enum: ['Admin', 'Employee'], required: true, index: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true }
}, { timestamps: true, collection: 'employees' }))
const Inquiry = mongoose.models.Inquiry || mongoose.model('Inquiry', new mongoose.Schema({
  buyer: { type: String, required: true, trim: true, maxlength: 160 },
  phoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  productId: { type: String, default: '', trim: true },
  product: { type: String, default: '', trim: true, maxlength: 160 },
  productImage: { type: String, default: '' },
  quantity: { type: String, default: '', trim: true, maxlength: 80 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['New', 'Responded', 'Not Interested', 'Order Confirmed'], default: 'New', index: true },
  readAt: { type: Date, default: null },
  notInterestedReason: { type: String, default: '', trim: true, maxlength: 2000 },
  finalMoq: { type: String, default: '', trim: true, maxlength: 80 },
  finalMessage: { type: String, default: '', trim: true, maxlength: 4000 },
  orderConfirmedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: Date.now },
  responses: [{ message: String, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true, collection: 'inquiries' }))
const ContactRequest = mongoose.models.ContactRequest || mongoose.model('ContactRequest', new mongoose.Schema({
  customerName: { type: String, required: true, trim: true, maxlength: 160 },
  phoneNumber: { type: String, required: true, trim: true, maxlength: 40 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  source: { type: String, default: '', trim: true, maxlength: 40 },
  idempotencyKey: { type: String, unique: true, sparse: true, select: false },
  status: { type: String, enum: ['New', 'Responded'], default: 'New', index: true },
  readAt: { type: Date, default: null },
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true, collection: 'contact_requests' }))
const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', new mongoose.Schema({
  customerId: { type: String, required: true, trim: true, index: true, unique: true },
  customerName: { type: String, required: true, trim: true },
  customerEmail: { type: String, required: true, trim: true, lowercase: true },
  lastMessageAt: { type: Date, default: Date.now },
  unreadCount: { type: Number, default: 0 },
  lastReadByAdminAt: { type: Date, default: null },
  lastReadByCustomerAt: { type: Date, default: null }
}, { timestamps: true, collection: 'conversations' }))
const Message = mongoose.models.Message || mongoose.model('Message', new mongoose.Schema({
  customerId: { type: String, required: true, trim: true, index: true },
  customerName: { type: String, default: '' },
  sender: { type: String, enum: ['customer', 'admin'], required: true, index: true },
  text: { type: String, default: '' },
  attachments: [{
    fileName: String,
    mimeType: String,
    size: Number,
    url: String,
    kind: String,
    productId: String,
    productTitle: String,
    productImage: String,
    productMoq: String
  }],
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true, collection: 'messages' }))
Category.schema.index({ status: 1, createdAt: -1, _id: -1 })
Product.schema.index({ status: 1, createdAt: -1, _id: -1 })
Product.schema.index({ category: 1, status: 1, createdAt: -1, _id: -1 })
Vendor.schema.index({ status: 1, createdAt: -1, _id: -1 })
Customer.schema.index({ status: 1, createdAt: -1, _id: -1 })
CustomerSession.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
CustomerPasswordReset.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
CustomerSignupVerification.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
Employee.schema.index({ status: 1, createdAt: -1, _id: -1 })
Conversation.schema.index({ lastMessageAt: -1, _id: -1 })
Message.schema.index({ customerId: 1, createdAt: -1, _id: -1 })
let mongoConnected = false
let mongoConnectionAttempt = null
let mongoReconnectTimer = null
let mongoReconnectDelay = 1000
const mongoReconnectMaxDelay = 10_000
const mongoReadRetryDelays = [150, 350]

const databaseState = () => mongoConnected && mongoose.connection.readyState === 1
const databaseUnavailableError = () => Object.assign(new Error('Database is temporarily unavailable'), { code: 'DATABASE_UNAVAILABLE', retryable: true })
const isTransientDatabaseError = (error) => {
  if (!error) return false
  if (error.code === 'DATABASE_UNAVAILABLE' || error.retryable) return true
  if (error.name === 'CastError' || error.name === 'ValidationError') return false
  if (['RetryableWriteError', 'TransientTransactionError'].some((label) => error.hasErrorLabel?.(label))) return true
  if ([6, 7, 89, 91, 189, 10107, 11600, 11602, 13435, 13436].includes(error.code)) return true
  return /^(?:MongoNetwork|MongoServerSelection|MongoNotConnected|MongoTopologyClosed|MongoPoolCleared|MongoWaitQueueTimeout|MongoOperationTimeout|MongooseServerSelection)/.test(error.name || '') || /buffering timed out|timed out selecting a server|topology is closed|not connected/i.test(error.message || '')
}
const sendDatabaseError = (res, error, fallbackMessage) => {
  if (isTransientDatabaseError(error)) {
    markMongoUnavailable(error)
    res.set('Retry-After', '1')
    return res.status(503).json({ message: 'Database is temporarily unavailable', retryable: true })
  }
  return res.status(500).json({ message: fallbackMessage })
}
const logAuthenticationFailure = (route, stage, error) => {
  const errorType = typeof error?.name === 'string' ? error.name : 'Error'
  const classification = isTransientDatabaseError(error)
    ? 'database_transient'
    : errorType.startsWith('Mongo') || errorType.startsWith('Mongoose')
      ? 'database'
      : 'unexpected'
  console.error('[auth] login_failed', { route, stage, classification, errorType })
}
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
const logDatabaseState = (state, error = null) => {
  const suffix = error ? `: ${error.message}` : ''
  console.log(`[database] state=${state}${suffix}`)
}
const clearMongoReconnectTimer = () => {
  if (!mongoReconnectTimer) return
  clearTimeout(mongoReconnectTimer)
  mongoReconnectTimer = null
}
const scheduleMongoReconnect = () => {
  if (!process.env.MONGODB_URI || mongoReconnectTimer || mongoConnectionAttempt || process.env.NODE_ENV === 'test') return
  mongoReconnectTimer = setTimeout(() => {
    mongoReconnectTimer = null
    void connectMongo().catch(() => { })
  }, mongoReconnectDelay)
  mongoReconnectTimer.unref?.()
  mongoReconnectDelay = Math.min(mongoReconnectDelay * 2, mongoReconnectMaxDelay)
}
const connectMongo = () => {
  if (!process.env.MONGODB_URI) {
    mongoConnected = false
    return Promise.resolve(false)
  }
  if (databaseState()) {
    clearMongoReconnectTimer()
    return Promise.resolve(true)
  }
  if (mongoConnectionAttempt) return mongoConnectionAttempt
  clearMongoReconnectTimer()
  const connectionPromise = () => {
    if (mongoose.connection.readyState === 2) return mongoose.connection.asPromise()
    if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection)
    return mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
      serverSelectionTimeoutMS: 5000
    })
  }
  const attempt = Promise.resolve().then(connectionPromise).then(async () => {
    if (mongoose.connection.readyState !== 1) throw databaseUnavailableError()
    if (mongoose.connection.db?.admin) await mongoose.connection.db.admin().ping()
    else if (process.env.NODE_ENV !== 'test') throw databaseUnavailableError()
    if (mongoose.connection.readyState !== 1) throw databaseUnavailableError()
    mongoConnected = true
    mongoReconnectDelay = 1000
    clearMongoReconnectTimer()
    logDatabaseState('ready')
    return true
  }).catch((error) => {
    mongoConnected = false
    logDatabaseState('unavailable', error)
    throw error
  }).finally(() => {
    if (mongoConnectionAttempt === attempt) mongoConnectionAttempt = null
    if (!databaseState()) scheduleMongoReconnect()
  })
  mongoConnectionAttempt = attempt
  return attempt
}
mongoose.connection.on('connected', () => {
  mongoConnected = mongoose.connection.readyState === 1
  if (!mongoConnected) return
  mongoReconnectDelay = 1000
  clearMongoReconnectTimer()
  logDatabaseState('connected')
})
mongoose.connection.on('reconnected', () => {
  mongoConnected = mongoose.connection.readyState === 1
  if (!mongoConnected) return
  mongoReconnectDelay = 1000
  clearMongoReconnectTimer()
  logDatabaseState('reconnected')
})
mongoose.connection.on('disconnected', () => {
  mongoConnected = false
  logDatabaseState('disconnected')
  scheduleMongoReconnect()
})
mongoose.connection.on('error', (error) => {
  mongoConnected = false
  logDatabaseState('error', error)
  scheduleMongoReconnect()
})
const markMongoUnavailable = (error) => {
  const wasConnected = mongoConnected
  mongoConnected = false
  if (wasConnected) logDatabaseState('unavailable', error)
  scheduleMongoReconnect()
}
const readWithRetry = async (operationName, operation) => {
  let lastError
  for (let attempt = 0; attempt <= mongoReadRetryDelays.length; attempt += 1) {
    try {
      if (!databaseState()) throw databaseUnavailableError()
      return await operation()
    } catch (error) {
      if (error.code !== 'DATABASE_UNAVAILABLE' || !lastError) lastError = error
      const transient = isTransientDatabaseError(error)
      if (transient) markMongoUnavailable(error)
      if (!transient || attempt === mongoReadRetryDelays.length) {
        console.error(`[database] read_failed operation=${operationName} attempts=${attempt + 1}: ${lastError.message}`)
        throw lastError
      }
      const delay = mongoReadRetryDelays[attempt]
      console.warn(`[database] read_retry operation=${operationName} attempt=${attempt + 1} delayMs=${delay}`)
      await sleep(delay)
      if (!databaseState() && process.env.NODE_ENV !== 'test') {
        try {
          await connectMongo()
        } catch {
          // Preserve the operation error; the next attempt can use the reconnect result.
        }
      }
    }
  }
  throw lastError
}

let products = [
  { _id: 'p1', name: 'Modular travel carry-on', category: 'Luggage Bags', moq: '100 units', price: '$28.40', status: 'Active', image: '/2.jpeg', images: ['/2.jpeg', '/1.jpeg', '/4.jpeg'], description: 'A durable, private-label carry-on designed for modern travel collections.', supplier: 'Northstar Travel Goods', createdAt: new Date().toISOString() },
  { _id: 'p2', name: 'Compact EV charging kit', category: 'EV', moq: '50 units', price: '$116.00', status: 'Active', image: '/3.jpeg', images: ['/3.jpeg', '/1.jpeg', '/5.jpeg'], description: 'A compact charging solution for retailers building dependable EV essentials.', supplier: 'Atlas Mobility Co.', createdAt: new Date().toISOString() },
  { _id: 'p3', name: 'Organic cotton nursery set', category: 'Baby Products', moq: '200 units', price: '$12.80', status: 'Active', image: '/4.jpeg', images: ['/4.jpeg', '/2.jpeg', '/1.jpeg'], description: 'Soft, certified cotton essentials ready for thoughtful nursery assortments.', supplier: 'Morrow Home Supply', createdAt: new Date().toISOString() },
  { _id: 'p4', name: 'Smart pet travel carrier', category: 'Pet Accessories', moq: '80 units', price: '$34.90', status: 'Active', image: '/5.jpeg', images: ['/5.jpeg', '/2.jpeg', '/3.jpeg'], description: 'A considered travel carrier combining comfort, safety, and retail-ready presentation.', supplier: 'Pawline Manufacturing', createdAt: new Date().toISOString() },
]
let categories = []
let vendors = []
let customers = []
let employees = []
let conversations = []
let conversationMessages = []
const sessions = new Map()
const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
let inquiries = [{ _id: 'i1', buyer: 'ABC Trading Ltd.', product: 'Compact EV charging kit', quantity: '500 units', message: 'Please provide your best price and delivery time.', status: 'New', submittedAt: new Date().toISOString(), responses: [] }]
const requireAdmin = (req, res, next) => {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const employee = token ? sessions.get(token) : null
  const legacyAdminKey = req.header('x-admin-key') === (process.env.ADMIN_KEY || 'omni-dev-key')
  if (!employee && !legacyAdminKey) return res.status(401).json({ message: 'Please log in to access the dashboard' })
  req.employee = employee
  next()
}
const requireDatabase = async (_req, res, next) => {
  if (databaseState()) return next()
  if (process.env.NODE_ENV !== 'test') {
    try {
      if (await connectMongo()) return next()
    } catch {
      // The readiness response below remains retryable for callers.
    }
  }
  scheduleMongoReconnect()
  res.set('Retry-After', '1')
  return res.status(503).json({ message: 'Database is temporarily unavailable', retryable: true })
}
const pageResult = (items, req) => { const page = Math.max(Number(req.query.page) || 1, 1); const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100); const start = (page - 1) * limit; return { data: items.slice(start, start + limit), page, limit, total: items.length, pages: Math.ceil(items.length / limit) } }
const sortNewest = (items) => [...items].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
const sortProductsForRequest = (items, req) => {
  const sortMode = String(req.query.sort || '').trim().toLowerCase();
  if (sortMode === 'hot-selling') {
    return sortHotSellingProducts(items, countInquiriesByProduct(inquiries))
  }
  return sortNewest(items)
}
const normalizeContactRequest = (contactRequest) => ({
  ...contactRequest,
  customerName: contactRequest.customerName || contactRequest.name || '',
  source: contactRequest.source || '',
  status: contactRequest.status === 'Contacted' ? 'Responded' : (contactRequest.status || 'New'),
  submittedAt: contactRequest.submittedAt || contactRequest.createdAt
})
const getDashboardBadgeCounts = async () => {
  if (mongoConnected) {
    const [conversationTotal, newInquiries, newContactRequests] = await readWithRetry('dashboard-badges', () => Promise.all([
      Conversation.aggregate([{ $group: { _id: null, totalUnread: { $sum: '$unreadCount' } } }]),
      Inquiry.countDocuments({ status: 'New' }),
      ContactRequest.countDocuments({ status: 'New' })
    ]))
    return { unreadMessages: Number(conversationTotal?.[0]?.totalUnread || 0), newInquiries: Number(newInquiries || 0), newContactRequests: Number(newContactRequests || 0) }
  }
  return {
    unreadMessages: conversations.reduce((sum, conversation) => sum + Number(conversation.unreadCount || 0), 0),
    newInquiries: inquiries.filter((inquiry) => inquiry.status === 'New' && !inquiry.readAt).length,
    newContactRequests: 0
  }
}
const emitBadgeChange = async (event = 'badge.changed', notification = null) => {
  try {
    io.emit(event, { ...(await getDashboardBadgeCounts()), ...(notification ? { notification } : {}) })
  } catch (error) {
    console.error('Badge update failed:', error.message)
  }
}
const normalizeNotification = (type, item, unread = true) => {
  const createdAt = item?.createdAt || item?.submittedAt || new Date().toISOString()
  if (type === 'Message') return {
    id: `message:${item._id}`,
    type,
    sender: item.sender || '',
    customerName: item.customerName || 'Customer',
    details: item.text || (item.attachments?.length ? `Attachment: ${item.attachments[0].fileName}` : 'New message'),
    createdAt,
    unread,
    target: `/dashboard/message?customerId=${encodeURIComponent(String(item.customerId || ''))}`,
    targetSection: 'Messages'
  }
  if (type === 'Inquiry') return {
    id: `inquiry:${item._id}`,
    type,
    customerName: item.buyer || 'Customer',
    details: item.message || item.product || 'New product inquiry',
    createdAt,
    unread,
    target: '/dashboard/inquiry',
    targetSection: 'Inquiries'
  }
  return {
    id: `contact-request:${item._id}`,
    type: 'Contact Request',
    customerName: item.customerName || item.name || 'Customer',
    details: item.message || 'New contact request',
    createdAt,
    unread,
    target: '/dashboard/contact-requests',
    targetSection: 'Contact Requests'
  }
}
const storedImagePath = (image) => image?.startsWith('/uploads/') ? path.join(uploadDirectory, path.basename(image)) : null
const removeStoredImage = async (image) => { const imagePath = storedImagePath(image); if (imagePath) await fs.promises.unlink(imagePath).catch((error) => { if (error.code !== 'ENOENT') throw error }) }
const resolveStoredAttachmentPath = (url) => {
  if (!url || typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null
  const candidate = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? new URL(trimmed).pathname : trimmed
  const relative = candidate.startsWith('/uploads/') ? candidate.slice('/uploads/'.length) : candidate.replace(/^uploads[\\/]+/, '')
  if (!relative || relative.includes('..')) return null
  const resolved = path.resolve(uploadDirectory, relative)
  return resolved.startsWith(uploadDirectory) ? resolved : null
}
const removeStoredAttachment = async (attachment) => {
  const url = attachment?.url || attachment?.filePath || attachment?.path
  const resolvedPath = resolveStoredAttachmentPath(url)
  if (!resolvedPath) return
  await fs.promises.unlink(resolvedPath).catch((error) => { if (error.code !== 'ENOENT') throw error })
}
const removeMessageAttachmentsFromStorage = async (message) => {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  await Promise.all(attachments.map((attachment) => removeStoredAttachment(attachment)))
}
const finalizeMessageDeletion = async (message) => {
  if (!message) return
  await removeMessageAttachmentsFromStorage(message)
  if (mongoConnected) {
    const deletedRecord = await Message.findByIdAndDelete(message._id).lean().catch(() => null)
    if (deletedRecord) {
      const remainingMessage = await Message.findOne({ customerId: message.customerId }).sort({ createdAt: -1 }).lean()
      if (remainingMessage) {
        await Conversation.findOneAndUpdate({ customerId: message.customerId }, { $set: { lastMessageAt: remainingMessage.createdAt || new Date(), unreadCount: 0 } }, { upsert: true, new: true, setDefaultsOnInsert: true })
      } else {
        await Conversation.deleteOne({ customerId: message.customerId })
      }
    }
    return
  }
  conversationMessages = conversationMessages.filter((item) => String(item._id) !== String(message._id))
  const conversation = conversations.find((item) => String(item.customerId) === String(message.customerId))
  if (conversation) {
    const remaining = conversationMessages.filter((item) => String(item.customerId) === String(message.customerId)).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    if (remaining.length) {
      conversation.lastMessageAt = new Date(remaining[0].createdAt)
      conversation.unreadCount = 0
    } else {
      const index = conversations.findIndex((item) => String(item.customerId) === String(message.customerId))
      if (index >= 0) conversations.splice(index, 1)
    }
  }
}
const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const getExpiredMessageCutoff = (now = new Date()) => new Date(new Date(now).getTime() - MESSAGE_RETENTION_MS)
const cleanupExpiredMessages = async (now = new Date()) => {
  const cutoff = getExpiredMessageCutoff(now)
  const expiredMessages = mongoConnected
    ? await Message.find({ createdAt: { $lte: cutoff } }).lean()
    : conversationMessages.filter((message) => new Date(message.createdAt) <= cutoff)
  for (const message of expiredMessages) await finalizeMessageDeletion(message)
  if (expiredMessages.length) await emitBadgeChange('message.changed')
  return { deletedCount: expiredMessages.length, cutoff }
}
const normalizeProduct = (product) => { const tiers = product.priceTiers?.length ? product.priceTiers : product.tiers?.length ? product.tiers : []; const lowestTier = tiers.reduce((lowest, tier) => !lowest || Number(tier.moqMin) < Number(lowest.moqMin) ? tier : lowest, null); const formatPrice = (value) => { const numericValue = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(numericValue) ? `$${numericValue.toFixed(2)}` : '$0.00' }; const formattedTiers = tiers.map((tier) => ({ ...tier, price: formatPrice(tier.price) })); return { ...product, priceTiers: formattedTiers, tiers: formattedTiers, image: product.image || product.images?.[0] || '', images: product.images || [], price: lowestTier ? formatPrice(lowestTier.price) : formatPrice(product.price), moq: lowestTier ? `${lowestTier.moqMin}-${lowestTier.moqMax}` : product.moq || '' } }
const normalizeMessageAttachment = (attachment) => ({
  fileName: attachment?.fileName || attachment?.originalname || 'attachment',
  mimeType: attachment?.mimeType || attachment?.mimetype || 'application/octet-stream',
  size: Number(attachment?.size || 0),
  url: attachment?.url || '',
  kind: attachment?.kind || 'document',
  ...(attachment?.kind === 'product' ? {
    productId: String(attachment.productId || ''),
    productTitle: attachment.productTitle || '',
    productImage: attachment.productImage || '',
    productMoq: attachment.productMoq || ''
  } : {})
})
const normalizeMessage = (message) => ({
  _id: message?._id || message?.id || `msg-${Date.now()}`,
  customerId: message?.customerId || '',
  customerName: message?.customerName || '',
  sender: message?.sender || 'admin',
  text: message?.text || '',
  attachments: Array.isArray(message?.attachments) ? message.attachments.map(normalizeMessageAttachment) : [],
  status: message?.status || 'sent',
  createdAt: message?.createdAt || new Date().toISOString()
})
const getConversationUnread = (conversation, messageCreatedAt) => {
  const base = Number(conversation?.unreadCount || 0)
  if (!messageCreatedAt || !conversation?.lastReadByAdminAt) return base
  const lastRead = new Date(conversation.lastReadByAdminAt).getTime()
  const messageTime = new Date(messageCreatedAt).getTime()
  if (Number.isNaN(lastRead) || Number.isNaN(messageTime)) return base
  return messageTime > lastRead ? base : 0
}
const markCustomerConversationRead = async (customerId) => {
  const targetCustomerId = String(customerId || '').trim()
  if (!targetCustomerId) return
  const timestamp = new Date()
  if (mongoConnected) {
    await Promise.all([
      Message.updateMany({ customerId: targetCustomerId, sender: 'customer', status: { $ne: 'read' } }, { $set: { status: 'read' } }),
      Conversation.updateOne({ customerId: targetCustomerId }, { $set: { unreadCount: 0, lastReadByAdminAt: timestamp } })
    ])
    return
  }
  const conversation = conversations.find((item) => String(item.customerId) === targetCustomerId)
  if (conversation) {
    conversation.unreadCount = 0
    conversation.lastReadByAdminAt = timestamp
  }
  conversationMessages.forEach((message) => {
    if (String(message.customerId) === targetCustomerId && message.sender === 'customer' && message.status !== 'read') {
      message.status = 'read'
    }
  })
}
const markAdminConversationRead = async (customerId) => {
  const targetCustomerId = String(customerId || '').trim()
  if (!targetCustomerId) return
  const timestamp = new Date()
  if (mongoConnected) {
    await Promise.all([
      Message.updateMany({ customerId: targetCustomerId, sender: 'admin', status: { $ne: 'read' } }, { $set: { status: 'read' } }),
      Conversation.updateOne({ customerId: targetCustomerId }, { $set: { lastReadByCustomerAt: timestamp } }, { upsert: true, new: true, setDefaultsOnInsert: true })
    ])
    return
  }
  const conversation = conversations.find((item) => String(item.customerId) === targetCustomerId)
  if (conversation) conversation.lastReadByCustomerAt = timestamp
  conversationMessages.forEach((message) => {
    if (String(message.customerId) === targetCustomerId && message.sender === 'admin' && message.status !== 'read') {
      message.status = 'read'
    }
  })
}
const hashEmployeePassword = (password) => crypto.scryptSync(password, process.env.PASSWORD_SALT || 'omni-dev-salt', 64).toString('hex')
const passwordMatches = (password, hash) => {
  if (typeof hash !== 'string' || !/^[a-f\d]{128}$/i.test(hash)) return false
  const expected = Buffer.from(hashEmployeePassword(password), 'hex')
  const actual = Buffer.from(hash, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
const hashPasswordResetCode = (resetId, code) => crypto.createHmac('sha256', process.env.PASSWORD_RESET_SECRET).update(`${resetId}:${code}`).digest('hex')
const resetCodeMatches = (resetId, code, storedHash) => {
  const expected = Buffer.from(hashPasswordResetCode(resetId, code), 'hex')
  const actual = Buffer.from(storedHash, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
const resetMailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD }
})
const sendPasswordResetCode = (emailAddress, code) => resetMailTransport.sendMail({
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  to: emailAddress,
  subject: 'Your Password Reset Verification Code',
  text: `Your Password Reset Verification Code\n\nUse the verification code below to securely reset your Vendor Woo account password.\n\n6-Digit Code: ${code}\n\nThis code is valid for 30 minutes.\n\nSecurity Notice\n- Never share this code with anyone.\n- Vendor Woo will never ask you for your verification code.\n- If you did not request a password reset, please ignore this email.\n\nThank you for using Vendor Woo.`,
  html: `<!doctype html><html><body style="margin:0;background:#f4f5f2;font-family:Arial,sans-serif;color:#263330"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e3e7e3"><div style="padding:22px 28px;background:#173b3a;color:#fff;font-size:24px;font-weight:700">Vendor<span style="color:#e66b4d">Woo</span></div><div style="padding:32px 28px"><h1 style="margin:0 0 14px;color:#173b3a;font-size:24px">Your Password Reset Verification Code</h1><p style="margin:0 0 18px;line-height:1.6;color:#3f4947">Use the verification code below to securely reset your Vendor Woo account password.</p><div style="margin:26px 0 18px;padding:18px 20px;text-align:center;background:#f4f5f2;border:1px solid #e6e8e2;border-radius:4px"><div style="font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#5b6764;margin-bottom:10px">6-Digit Code</div><div style="color:#173b3a;font-size:32px;font-weight:700;letter-spacing:8px">${code}</div></div><p style="margin:0 0 18px;line-height:1.6;color:#3f4947">This code is valid for <strong>30 minutes</strong>.</p><div style="margin-top:26px;padding:18px 20px;background:#f8faf8;border-left:4px solid #e66b4d"><h2 style="margin:0 0 12px;color:#173b3a;font-size:18px">Security Notice</h2><ul style="margin:0;padding-left:18px;line-height:1.7;color:#3f4947"><li>Never share this code with anyone.</li><li>VendorWoo will never ask you for your verification code.</li><li>If you did not request a password reset, please ignore this email.</li></ul></div><p style="margin:22px 0 0;line-height:1.6;color:#3f4947">Thank you for using VendorWoo.</p></div><div style="padding:16px 28px;color:#89918e;font-size:12px">VendorWoo - Global B2B Marketplace</div></div></body></html>`
})
const sendSignupVerificationCode = (emailAddress, code) => resetMailTransport.sendMail({
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  to: emailAddress,
  subject: 'Verify your VendorWoo account',
  text: `Your VendorWoo verification code is ${code}. It expires in 30 minutes. Enter this 6-digit code to verify your email and complete account creation. Thank you for choosing VendorWoo.`,
  html: `<!doctype html><html><body style="margin:0;background:#f4f5f2;font-family:Arial,sans-serif;color:#263330"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e3e7e3"><div style="padding:22px 28px;background:#173b3a;color:#fff;font-size:24px;font-weight:700">Vendor<span style="color:#e66b4d">Woo</span></div><div style="padding:32px 28px"><h1 style="margin:0 0 14px;color:#173b3a;font-size:24px">Verify your email address</h1><p style="line-height:1.6">Use the 6-digit code below to verify your email and complete your VendorWoo account creation.</p><div style="margin:26px 0;padding:18px;text-align:center;background:#f4f5f2;color:#173b3a;font-size:32px;font-weight:700;letter-spacing:8px">${code}</div><p style="line-height:1.6">This code expires in 30 minutes. Thank you for choosing VendorWoo.</p></div><div style="padding:16px 28px;color:#89918e;font-size:12px">VendorWoo - Global B2B Marketplace</div></div></body></html>`
})
const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;')
const getPublicBaseUrl = () => {
  const configured = [process.env.PUBLIC_BASE_URL, process.env.ASSET_BASE_URL, process.env.API_PUBLIC_URL].find((value) => Boolean(value && String(value).trim()))
  return String(configured || 'https://server.vendorwoo.com').trim().replace(/\/+$/, '')
}
const toEmailAssetUrl = (value) => {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  const baseUrl = getPublicBaseUrl()
  if (/^data:/i.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    try {
      const parsed = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed)
      if (parsed.pathname.startsWith('/uploads/')) return `${baseUrl}${parsed.pathname}${parsed.search}`
    } catch {
      return trimmed
    }
    return trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  }
  return baseUrl ? `${baseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}` : trimmed
}
const sendInquiryConfirmationEmail = async (inquiry) => {
  const customerEmail = String(inquiry?.email || '').trim().toLowerCase()
  if (!customerEmail) return
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) {
    console.warn('Inquiry confirmation email skipped because SMTP is not configured.')
    return
  }
  const productTitle = inquiry?.product || 'Product inquiry'
  const productDescription = inquiry?.productDescription || inquiry?.message || 'No additional product details were provided.'
  const productImage = toEmailAssetUrl(inquiry?.productImage || inquiry?.image || '/1.jpeg')
  const moq = inquiry?.quantity || 'Not specified'
  const customerName = inquiry?.buyer || 'Customer'
  const productDescriptionHtml = escapeHtml(productDescription).replace(/\n/g, '<br>')
  const emailHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VendorWoo Inquiry Confirmation</title>
  </head>
  <body style="margin:0;background:#f5f7f5;font-family:Arial,Helvetica,sans-serif;color:#263330;line-height:1.6;">
    <div style="max-width:680px;margin:32px auto;background:#ffffff;border:1px solid #dfe7e2;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(23,59,58,0.08);">
      <div style="padding:22px 28px;background:#173b3a;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.02em;">
        Vendor<span style="color:#e66b4d;">Woo</span>
      </div>
      <div style="padding:32px 28px 24px;">
        <p style="margin:0 0 10px;color:#6a756f;font-size:12px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">Inquiry confirmation</p>
        <h1 style="margin:0 0 14px;color:#173b3a;font-size:30px;line-height:1.2;font-weight:700;">Hello ${escapeHtml(customerName)},</h1>
        <p style="margin:0 0 18px;color:#3f4947;font-size:16px;line-height:1.7;">
          Thank you for choosing VendorWoo. Your inquiry has been successfully submitted. Our vendor will review your requirements and contact you shortly.
        </p>

        <div style="background:#f5faf8;border:1px solid #dfece7;border-radius:10px;padding:18px 20px;margin:26px 0;">
          <p style="margin:0 0 8px;color:#5c6b68;font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">Inquiry Summary</p>
          <div style="display:block;">
            <div style="width:100%;margin:0 auto 18px;text-align:center;">
              ${productImage ? `<img src="${productImage}" alt="${escapeHtml(productTitle)}" style="width:100%;max-width:140px;height:120px;margin:0 auto;border-radius:8px;object-fit:cover;border:1px solid #dfe7e2;background:#f2f4f2;display:block;" />` : '<div style="width:140px;height:120px;margin:0 auto;border-radius:8px;background:#edf1ef;border:1px solid #dfe7e2;display:flex;align-items:center;justify-content:center;color:#5b6764;font-size:12px;text-align:center;">Product<br />Image</div>'}
            </div>
            <div style="width:100%;min-width:0;">
              <p style="margin:0 0 8px;color:#173b3a;font-size:24px;font-weight:700;line-height:1.25;">${escapeHtml(productTitle)}</p>
              <div style="margin:10px 0 8px;padding:10px 12px;border-radius:8px;background:#fff;border:1px solid #e0e7e2;display:inline-block;">
                <span style="display:block;color:#5f6e6c;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">Selected MOQ</span>
                <span style="display:block;color:#173b3a;font-size:22px;font-weight:800;line-height:1.3;">${escapeHtml(moq)}</span>
              </div>
            </div>
          </div>
        </div>

        <div style="margin:24px 0; padding:20px 18px; background:#fafcfb; border:1px solid #e4e9e5; border-radius:10px;">
          <p style="margin:0 0 10px;color:#173b3a;font-size:18px;font-weight:700;">Product details</p>
          <p style="margin:0;color:#3f4947;font-size:15px;line-height:1.7;">${productDescriptionHtml}</p>
        </div>

        <div style="margin-top:18px;border-top:1px solid #e7ece8;padding-top:20px;">
          <p style="margin:0 0 12px;color:#173b3a;font-size:18px;font-weight:700;">Your inquiry information</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;color:#5d6b69;font-size:14px;font-weight:700;width:120px;">Customer:</td>
              <td style="padding:8px 0;color:#173b3a;font-size:14px;">${escapeHtml(customerName)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#5d6b69;font-size:14px;font-weight:700;">Email:</td>
              <td style="padding:8px 0;color:#173b3a;font-size:14px;">${escapeHtml(customerEmail)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#5d6b69;font-size:14px;font-weight:700;vertical-align:top;">Request:</td>
              <td style="padding:8px 0;color:#173b3a;font-size:14px;line-height:1.6;">${escapeHtml(inquiry?.message || 'No additional message provided.')}</td>
            </tr>
          </table>
        </div>
      </div>

      <div style="padding:18px 28px 24px;background:#f7f8f7;border-top:1px solid #e5e8e5;color:#6c7774;font-size:12px;line-height:1.7;">
        <p style="margin:0 0 8px;">VendorWoo helps buyers and suppliers connect faster across global sourcing opportunities.</p>
        <p style="margin:0;">If you need to update your inquiry or have additional requirements, please reply to this email or contact the vendor directly through VendorWoo.</p>
      </div>
    </div>
  </body>
</html>`

  await resetMailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customerEmail,
    subject: 'Your VendorWoo inquiry has been received',
    text: `Thank you for choosing VendorWoo. Your inquiry for ${productTitle} has been successfully submitted. Our vendor will review your requirements and contact you shortly.`,
    html: emailHtml
  })
}
const triggerInquiryConfirmationEmail = (inquiry) => {
  if (!inquiry || !inquiry.email) return
  Promise.resolve()
    .then(() => sendInquiryConfirmationEmail(inquiry))
    .catch((error) => {
      console.error('Inquiry confirmation email failed:', error)
    })
}
const sendOrderConfirmationEmail = async (inquiry) => {
  const customerEmail = String(inquiry?.email || '').trim().toLowerCase()
  if (!customerEmail) return { skipped: true, reason: 'Inquiry has no customer email address' }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) {
    console.warn('Order confirmation email skipped because SMTP is not configured.')
    return { skipped: true, reason: 'SMTP is not configured' }
  }
  const productTitle = inquiry?.product || 'your requested product'
  const customerName = inquiry?.buyer || 'Customer'
  const finalMoq = inquiry?.finalMoq || inquiry?.quantity || 'Not specified'
  const finalMoqLabel = /units?$/i.test(String(finalMoq).trim()) ? String(finalMoq).trim() : `${String(finalMoq).trim()} units`
  const productImage = toEmailAssetUrl(inquiry?.productImage || inquiry?.image || '/1.jpeg')
  const originalMessage = inquiry?.message || 'No additional message provided.'
  const finalMessage = inquiry?.finalMessage || `Thank you for choosing us! 🎉\n\nWe’re happy to let you know that your order for ${productTitle} has been successfully confirmed.\n\n📦 Confirmed Quantity: ${finalMoqLabel}\n\nThank you for your trust and for choosing to work with us. Our team will now proceed with the next steps and will contact you shortly with any further order details.\n\nWe truly appreciate your business and look forward to serving you!`
  const emailHtml = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f7f5;font-family:Arial,Helvetica,sans-serif;color:#263330;line-height:1.6;"><div style="max-width:680px;margin:32px auto;background:#fff;border:1px solid #dfe7e2;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(23,59,58,.08);"><div style="padding:22px 28px;background:#173b3a;color:#fff;font-size:24px;font-weight:700;">Vendor<span style="color:#e66b4d;">Woo</span></div><div style="padding:32px 28px 24px;"><p style="margin:0 0 10px;color:#177c78;font-size:12px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">Order confirmed</p><h1 style="margin:0 0 14px;color:#173b3a;font-size:30px;line-height:1.2;">Hello ${escapeHtml(customerName)},</h1><p style="margin:0 0 22px;color:#3f4947;font-size:16px;">Your order has been successfully confirmed.</p><div style="background:#f5faf8;border:1px solid #dfece7;border-radius:10px;padding:18px 20px;margin:26px 0;"><div style="display:block;"><div style="width:100%;margin:0 auto 18px;text-align:center;">${productImage ? `<img src="${productImage}" alt="${escapeHtml(productTitle)}" style="width:100%;max-width:140px;height:120px;margin:0 auto;border-radius:8px;object-fit:cover;border:1px solid #dfe7e2;background:#f2f4f2;display:block;" />` : ''}</div><div style="width:100%;min-width:0;"><p style="margin:0 0 12px;color:#173b3a;font-size:24px;font-weight:700;line-height:1.25;">${escapeHtml(productTitle)}</p><p style="margin:0;color:#5f6e6c;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;">Final MOQ</p><p style="margin:2px 0 0;color:#173b3a;font-size:22px;font-weight:800;">${escapeHtml(finalMoqLabel)}</p></div></div></div><div style="margin:24px 0;padding:20px 18px;background:#fafcfb;border:1px solid #e4e9e5;border-radius:10px;"><p style="margin:0 0 10px;color:#173b3a;font-size:18px;font-weight:700;">Confirmation message</p><p style="margin:0;color:#3f4947;font-size:15px;">${escapeHtml(finalMessage).replace(/\n/g, '<br>')}</p></div><div style="margin-top:18px;border-top:1px solid #e7ece8;padding-top:20px;"><p style="margin:0 0 12px;color:#173b3a;font-size:18px;font-weight:700;">Inquiry details</p><p style="margin:0 0 8px;color:#3f4947;"><strong>Customer:</strong> ${escapeHtml(customerName)}</p><p style="margin:0;color:#3f4947;"><strong>Original request:</strong> ${escapeHtml(originalMessage).replace(/\n/g, '<br>')}</p></div></div><div style="padding:18px 28px 24px;background:#f7f8f7;border-top:1px solid #e5e8e5;color:#6c7774;font-size:12px;"><p style="margin:0;">VendorWoo - Global B2B Marketplace</p></div></div></body></html>`
  await resetMailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customerEmail,
    subject: `Order confirmed: ${productTitle}`,
    text: `Order Confirmed\n\nHello ${customerName},\n\nYour order for ${productTitle} has been successfully confirmed. Final MOQ: ${finalMoqLabel}.\n\n${finalMessage}\n\nOriginal inquiry: ${originalMessage}`,
    html: emailHtml
  })
}
const sendOrderConfirmationEmailSafely = async (inquiry) => {
  try {
    const result = await sendOrderConfirmationEmail(inquiry)
    if (result?.skipped) {
      console.warn('Order confirmation email was not sent:', { inquiryId: inquiry?._id, to: inquiry?.email, reason: result.reason })
      return { sent: false, skipped: true }
    }
    console.info('Order confirmation email sent:', { inquiryId: inquiry?._id, to: inquiry?.email, messageId: result?.messageId, response: result?.response })
    return { sent: true, result }
  } catch (error) {
    console.error('Order confirmation email failed:', { inquiryId: inquiry?._id, to: inquiry?.email, code: error.code, responseCode: error.responseCode, command: error.command, message: error.message })
    return { sent: false, error }
  }
}
const readCookie = (req, name) => { const value = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return value ? decodeURIComponent(value.slice(name.length + 1)) : '' }
const hashCustomerSessionToken = (token) => crypto.createHash('sha256').update(token).digest('hex')
const googleClient = new OAuth2Client()
const googleClientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim()
const googleSignupTokenSecret = () => String(process.env.GOOGLE_SIGNUP_TOKEN_SECRET || process.env.PASSWORD_RESET_SECRET || '').trim()
const encodeTokenPart = (value) => Buffer.from(value).toString('base64url')
const decodeTokenPart = (value) => Buffer.from(value, 'base64url').toString('utf8')
const createGoogleSignupToken = (identity) => {
  const secret = googleSignupTokenSecret()
  if (!secret) throw new Error('Google signup token secret is not configured')
  const payload = encodeTokenPart(JSON.stringify({ ...identity, exp: Date.now() + 10 * 60 * 1000 }))
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}
const readGoogleSignupToken = (token) => {
  const secret = googleSignupTokenSecret()
  if (!secret || typeof token !== 'string') throw new Error('Invalid Google signup session')
  const [payload, signature] = token.split('.')
  const expected = crypto.createHmac('sha256', secret).update(payload || '').digest('base64url')
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid Google signup session')
  let identity
  try {
    identity = JSON.parse(decodeTokenPart(payload))
  } catch {
    throw new Error('Invalid Google signup session')
  }
  if (!identity.sub || !identity.email || Number(identity.exp) <= Date.now()) throw new Error('Google signup session expired')
  return identity
}
const verifyGoogleCredential = async (credential) => {
  if (!googleClientId() || !credential) throw Object.assign(new Error('Google authentication is not configured'), { code: 'GOOGLE_AUTH_UNAVAILABLE' })
  let ticket
  try {
    ticket = await googleClient.verifyIdToken({ idToken: String(credential), audience: googleClientId() })
  } catch {
    throw Object.assign(new Error('Google account could not be verified'), { code: 'GOOGLE_AUTH_INVALID' })
  }
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email || payload.email_verified !== true) throw Object.assign(new Error('Google account could not be verified'), { code: 'GOOGLE_AUTH_INVALID' })
  return {
    sub: String(payload.sub),
    email: String(payload.email).trim().toLowerCase(),
    name: String(payload.name || payload.email.split('@')[0]).trim().slice(0, 160)
  }
}
const buildCustomerSessionCookieValue = (token) => {
  const sameSite = ['Strict', 'Lax', 'None'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : process.env.NODE_ENV === 'production' ? 'None' : 'Lax'
  const secureFlag = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
  return `omni_customer_session=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=2592000${secureFlag}`
}
const setCustomerCookie = (res, token) => res.setHeader('Set-Cookie', buildCustomerSessionCookieValue(token))
const clearCustomerCookie = (res) => {
  const sameSite = ['Strict', 'Lax', 'None'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : process.env.NODE_ENV === 'production' ? 'None' : 'Lax'
  const secureFlag = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
  return res.setHeader('Set-Cookie', `omni_customer_session=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secureFlag}`)
}
const serializeCustomer = (customer) => ({
  _id: customer?._id,
  customerName: customer?.customerName,
  phoneNumber: customer?.phoneNumber,
  emailAddress: customer?.emailAddress,
  role: customer?.role || 'CUSTOMER'
})
const findCustomerSessionRecord = async (req) => {
  const token = readCookie(req, 'omni_customer_session')
  if (!token) return null
  const tokenHash = hashCustomerSessionToken(token)
  const session = await readWithRetry('customer-session', () => CustomerSession.findOne({
    tokenHash,
    status: 'active',
    revokedAt: null,
    expiresAt: { $gt: new Date() }
  }).lean())
  if (!session) return null
  const customer = await readWithRetry('customer-session-customer', () => Customer.findById(session.customerId).lean())
  if (!customer || customer.role !== 'CUSTOMER' || customer.status !== 'Active') {
    await readWithRetry('customer-session-revoke-invalid', () => CustomerSession.updateOne({ _id: session._id }, { $set: { status: 'revoked', revokedAt: new Date() } }))
    return null
  }
  await readWithRetry('customer-session-touch', () => CustomerSession.updateOne({ _id: session._id }, { $set: { updatedAt: new Date() } }))
  return serializeCustomer(customer)
}
const requireCustomer = async (req, res, next) => {
  try {
    const customer = await findCustomerSessionRecord(req)
    if (!customer) return res.status(401).json({ message: 'Customer sign-in required' })
    req.customer = customer
    next()
  } catch (error) {
    console.error('Customer auth validation failed:', error)
    return sendDatabaseError(res, error, 'Unable to validate customer session')
  }
}
const createCustomerSessionToken = async (customer, onStage = () => { }) => {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashCustomerSessionToken(token)
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS)
  onStage('customer_session_create')
  const sessionRecord = { customerId: customer._id, tokenHash, expiresAt, status: 'active', revokedAt: null }
  const createdSession = await readWithRetry('customer-session-create', async () => {
    try {
      return await CustomerSession.create(sessionRecord)
    } catch (error) {
      if (error.code !== 11000) throw error
      const existing = await CustomerSession.findOne({ customerId: customer._id, tokenHash }).lean()
      if (existing) return existing
      throw error
    }
  })
  try {
    onStage('customer_session_revoke_existing')
    await readWithRetry('customer-session-revoke-existing', () => CustomerSession.updateMany({ customerId: customer._id, status: 'active', revokedAt: null, _id: { $ne: createdSession._id } }, { $set: { status: 'revoked', revokedAt: new Date() } }))
  } catch (error) {
    try {
      await readWithRetry('customer-session-rollback', () => CustomerSession.deleteOne({ _id: createdSession._id }))
    } catch (cleanupError) {
      logAuthenticationFailure('customer-session', 'customer_session_rollback', cleanupError)
    }
    throw error
  }
  return { token, customer: serializeCustomer(customer) }
}

app.post('/api/customer-auth/signup/request', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const customerName = String(req.body.customerName || '').trim(); const phoneNumber = String(req.body.phoneNumber || '').trim(); const emailAddress = String(req.body.emailAddress || '').trim().toLowerCase(); const password = String(req.body.password || ''); const confirmPassword = String(req.body.confirmPassword || '')
  if (!customerName || !phoneNumber || !emailAddress || !password || !confirmPassword) return res.status(400).json({ message: 'Complete all customer fields' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' })
  if (!process.env.PASSWORD_RESET_SECRET || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ message: 'Email verification is not configured' })
  try {
    const existing = await readWithRetry('customer-signup-existing', () => Customer.findOne({ emailAddress }).lean())
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' })
    const signupId = crypto.randomBytes(24).toString('hex')
    const code = String(crypto.randomInt(100000, 1000000))
    await CustomerSignupVerification.deleteMany({ emailAddress })
    await CustomerSignupVerification.create({ _id: signupId, customerName, phoneNumber, emailAddress, password: hashEmployeePassword(password), codeHash: hashPasswordResetCode(signupId, code), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })
    try {
      await sendSignupVerificationCode(emailAddress, code)
    } catch (mailError) {
      await CustomerSignupVerification.deleteOne({ _id: signupId })
      throw mailError
    }
    return res.json({ signupId })
  } catch (error) { console.error('Customer signup verification request failed:', error.message); return sendDatabaseError(res, error, 'Unable to send email verification code') }
})
app.post('/api/customer-auth/signup/verify', signupVerificationRateLimit, requireDatabase, async (req, res) => {
  const signupId = String(req.body.signupId || '').trim()
  const code = String(req.body.code || '').trim()
  if (!/^[a-f0-9]{48}$/.test(signupId) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit verification code' })
  try {
    const pending = await CustomerSignupVerification.findOne({ _id: signupId, expiresAt: { $gt: new Date() }, usedAt: null }).select('+password +codeHash').lean()
    if (!pending || pending.attempts >= 10) return res.status(400).json({ message: 'This verification code is invalid or expired' })
    if (!resetCodeMatches(signupId, code, pending.codeHash)) {
      await CustomerSignupVerification.updateOne({ _id: signupId }, { $inc: { attempts: 1 } })
      return res.status(400).json({ message: 'This verification code is invalid or expired' })
    }
    const claimed = await CustomerSignupVerification.findOneAndUpdate({ _id: signupId, expiresAt: { $gt: new Date() }, usedAt: null }, { $set: { verifiedAt: new Date(), usedAt: new Date() } }, { new: true }).lean()
    if (!claimed) return res.status(400).json({ message: 'This verification code is invalid or expired' })
    const existing = await Customer.findOne({ emailAddress: pending.emailAddress }).lean()
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' })
    const customer = await Customer.create({ customerName: pending.customerName, phoneNumber: pending.phoneNumber, emailAddress: pending.emailAddress, password: pending.password, role: 'CUSTOMER', status: 'Active' }).then((item) => item.toObject())
    const session = await createCustomerSessionToken(customer)
    setCustomerCookie(res, session.token)
    return res.status(201).json({ customer: session.customer })
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'An account with this email already exists' })
    console.error('Customer signup verification failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to create customer account')
  }
})
app.post('/api/customer-auth/signup', requireDatabase, (_req, res) => res.status(400).json({ message: 'Verify your email before creating your account' }))
/* Legacy route remains explicit so accounts cannot bypass email verification. */
app.post('/api/customer-auth/login', requireDatabase, async (req, res) => {
  const emailAddress = String(req.body.emailAddress || '').trim().toLowerCase(); const password = String(req.body.password || '')
  if (!emailAddress || !password) return res.status(400).json({ message: 'Email and password are required' })
  let failureStage = 'customer_lookup'
  try {
    const customer = await readWithRetry('customer-login', () => Customer.findOne({ emailAddress, status: 'Active', role: 'CUSTOMER' }).select('+password').lean())
    failureStage = 'password_verification'
    if (!customer?.password || !passwordMatches(password, customer.password)) return res.status(401).json({ message: 'Invalid customer credentials' })
    const session = await createCustomerSessionToken(customer, (stage) => { failureStage = stage })
    failureStage = 'customer_session_response'
    setCustomerCookie(res, session.token)
    return res.json({ customer: session.customer })
  } catch (error) {
    logAuthenticationFailure('POST /api/customer-auth/login', failureStage, error)
    return sendDatabaseError(res, error, 'Unable to sign in')
  }
})
app.post('/api/customer-auth/google', requireDatabase, async (req, res) => {
  const intent = String(req.body.intent || 'signin').trim().toLowerCase()
  try {
    const identity = await verifyGoogleCredential(req.body.credential)
    let customer = await readWithRetry('google-customer', () => Customer.findOne({ googleSub: identity.sub, role: 'CUSTOMER' }).lean())
    if (customer && customer.status !== 'Active') return res.status(403).json({ message: 'This customer account is not active' })
    if (!customer) {
      const sameEmail = await readWithRetry('google-customer-email', () => Customer.findOne({ emailAddress: identity.email, role: 'CUSTOMER' }).lean())
      if (sameEmail) {
        if (sameEmail.googleSub && sameEmail.googleSub !== identity.sub) return res.status(409).json({ message: 'This email is already linked to another Google account' })
        customer = await readWithRetry('google-customer-link', async () => {
          const linked = await Customer.findOneAndUpdate({ _id: sameEmail._id, googleSub: { $exists: false } }, { $set: { googleSub: identity.sub, authProvider: 'google' } }, { new: true }).lean()
          return linked || Customer.findOne({ _id: sameEmail._id, googleSub: identity.sub, role: 'CUSTOMER' }).lean()
        })
        if (!customer) return res.status(409).json({ message: 'This customer account was updated. Please try Google sign-in again' })
      }
    }
    if (customer) {
      if (customer.status !== 'Active') return res.status(403).json({ message: 'This customer account is not active' })
      const session = await createCustomerSessionToken(customer)
      setCustomerCookie(res, session.token)
      return res.json({ customer: session.customer })
    }
    if (intent !== 'signup') return res.status(404).json({ message: 'No customer account was found. Please use Sign up with Google first' })
    return res.json({ requiresPhone: true, googleSignupToken: createGoogleSignupToken(identity), customer: { customerName: identity.name, emailAddress: identity.email } })
  } catch (error) {
    if (error.code === 'GOOGLE_AUTH_INVALID' || error.code === 'GOOGLE_AUTH_UNAVAILABLE' || error.message === 'Invalid Google signup session') return res.status(400).json({ message: error.code === 'GOOGLE_AUTH_UNAVAILABLE' ? 'Google sign-in is not configured' : 'Google authentication could not be verified' })
    if (error.code === 11000) return res.status(409).json({ message: 'This Google account is already linked to a customer' })
    console.error('Google customer authentication failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to complete Google authentication')
  }
})
app.post('/api/customer-auth/google/complete', requireDatabase, async (req, res) => {
  const phoneNumber = String(req.body.phoneNumber || '').trim()
  if (!/^\+?[\d\s().-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  if (req.body.agreedTerms !== true) return res.status(400).json({ message: 'Please agree to the Terms and Conditions' })
  try {
    const identity = readGoogleSignupToken(req.body.googleSignupToken)
    let customer = await readWithRetry('google-complete-customer', () => Customer.findOne({ googleSub: identity.sub, role: 'CUSTOMER' }).lean())
    if (!customer) {
      const sameEmail = await readWithRetry('google-complete-email', () => Customer.findOne({ emailAddress: identity.email, role: 'CUSTOMER' }).lean())
      if (sameEmail?.googleSub && sameEmail.googleSub !== identity.sub) return res.status(409).json({ message: 'This email is already linked to another Google account' })
      if (sameEmail) {
        customer = await readWithRetry('google-complete-customer-link', async () => {
          const linked = await Customer.findOneAndUpdate({ _id: sameEmail._id, googleSub: { $exists: false } }, { $set: { googleSub: identity.sub, authProvider: 'google', phoneNumber } }, { new: true }).lean()
          return linked || Customer.findOne({ _id: sameEmail._id, googleSub: identity.sub, phoneNumber, role: 'CUSTOMER' }).lean()
        })
      } else {
        const newCustomer = { customerName: identity.name, phoneNumber, emailAddress: identity.email, password: hashEmployeePassword(crypto.randomBytes(32).toString('hex')), googleSub: identity.sub, authProvider: 'google', role: 'CUSTOMER', status: 'Active' }
        customer = await readWithRetry('google-customer-create', async () => {
          try {
            return await Customer.create(newCustomer).then((item) => item.toObject())
          } catch (error) {
            if (error.code !== 11000) throw error
            const existing = await Customer.findOne({ googleSub: identity.sub, role: 'CUSTOMER' }).lean()
            if (existing) return existing
            throw error
          }
        })
      }
    }
    if (customer.status !== 'Active') return res.status(403).json({ message: 'This customer account is not active' })
    const session = await createCustomerSessionToken(customer)
    setCustomerCookie(res, session.token)
    return res.status(201).json({ customer: session.customer })
  } catch (error) {
    if (/Google signup session|valid phone/i.test(error.message)) return res.status(400).json({ message: 'Your Google signup session is invalid or expired' })
    if (error.code === 11000) return res.status(409).json({ message: 'This Google account is already linked to a customer' })
    console.error('Google customer signup completion failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to complete your Google signup')
  }
})
app.post('/api/customer-auth/forgot-password/request', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const emailAddress = String(req.body.emailAddress || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!process.env.PASSWORD_RESET_SECRET || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ message: 'Password reset email is not configured' })
  try {
    const customer = await Customer.findOne({ emailAddress, status: 'Active', role: 'CUSTOMER' }).select('_id emailAddress').lean()
    if (!customer) return res.status(404).json({ message: 'No account is registered with that email address' })
    const resetId = crypto.randomBytes(24).toString('hex')
    const code = String(crypto.randomInt(100000, 1000000))
    await CustomerPasswordReset.deleteMany({ customerId: customer._id })
    await CustomerPasswordReset.create({ customerId: customer._id, emailAddress, codeHash: hashPasswordResetCode(resetId, code), expiresAt: new Date(Date.now() + 30 * 60 * 1000), _id: resetId })
    try {
      await sendPasswordResetCode(emailAddress, code)
    } catch (mailError) {
      await CustomerPasswordReset.deleteOne({ _id: resetId })
      throw mailError
    }
    return res.json({ resetId })
  } catch (error) {
    console.error('Password reset request failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to send password reset code')
  }
})
app.post('/api/customer-auth/forgot-password/verify', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const resetId = String(req.body.resetId || '').trim()
  const code = String(req.body.code || '').trim()
  if (!/^[a-f0-9]{48}$/.test(resetId) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit verification code' })
  try {
    const reset = await CustomerPasswordReset.findOne({ _id: resetId, expiresAt: { $gt: new Date() }, verifiedAt: null, usedAt: null }).select('+codeHash').lean()
    if (!reset || reset.attempts >= 5) return res.status(400).json({ message: 'This verification code is invalid or expired' })
    if (!resetCodeMatches(resetId, code, reset.codeHash)) {
      await CustomerPasswordReset.updateOne({ _id: resetId }, { $inc: { attempts: 1 } })
      return res.status(400).json({ message: 'This verification code is invalid or expired' })
    }
    await CustomerPasswordReset.updateOne({ _id: resetId }, { $set: { verifiedAt: new Date() } })
    return res.json({ verified: true })
  } catch (error) {
    console.error('Password reset verification failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to verify password reset code')
  }
})
app.post('/api/customer-auth/forgot-password/reset', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const resetId = String(req.body.resetId || '').trim()
  const password = String(req.body.password || '')
  const confirmPassword = String(req.body.confirmPassword || '')
  if (!/^[a-f0-9]{48}$/.test(resetId)) return res.status(400).json({ message: 'Your password reset session is invalid' })
  if (!password || !confirmPassword) return res.status(400).json({ message: 'Enter and confirm your new password' })
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' })
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
  try {
    const reset = await CustomerPasswordReset.findOneAndUpdate({ _id: resetId, expiresAt: { $gt: new Date() }, verifiedAt: { $ne: null }, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true }).lean()
    if (!reset) return res.status(400).json({ message: 'Your password reset session is invalid or expired' })
    const customer = await Customer.findOneAndUpdate({ _id: reset.customerId, emailAddress: reset.emailAddress, status: 'Active', role: 'CUSTOMER' }, { $set: { password: hashEmployeePassword(password) } }, { new: true }).lean()
    if (!customer) return res.status(404).json({ message: 'Customer account not found' })
    await CustomerPasswordReset.deleteOne({ _id: resetId })
    return res.json({ reset: true })
  } catch (error) {
    console.error('Password reset failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to update your password')
  }
})
app.post('/api/auth/forgot-password/request', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const emailAddress = String(req.body.emailAddress || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!process.env.PASSWORD_RESET_SECRET || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return res.status(503).json({ message: 'Password reset email is not configured' })
  try {
    const employee = await Employee.findOne({ emailAddress, status: 'Active' }).select('_id emailAddress').lean()
    const resetId = crypto.randomBytes(24).toString('hex')
    if (employee) {
      const code = String(crypto.randomInt(100000, 1000000))
      await CustomerPasswordReset.deleteMany({ employeeId: employee._id, accountType: 'employee' })
      await CustomerPasswordReset.create({ _id: resetId, employeeId: employee._id, emailAddress, accountType: 'employee', codeHash: hashPasswordResetCode(resetId, code), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })
      try {
        await sendPasswordResetCode(emailAddress, code)
      } catch (mailError) {
        await CustomerPasswordReset.deleteOne({ _id: resetId })
        throw mailError
      }
    }
    return res.json({ resetId })
  } catch (error) {
    console.error('Employee password reset request failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to send password reset code')
  }
})
app.post('/api/auth/forgot-password/verify', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const resetId = String(req.body.resetId || '').trim()
  const code = String(req.body.code || '').trim()
  if (!/^[a-f0-9]{48}$/.test(resetId) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit verification code' })
  try {
    const reset = await CustomerPasswordReset.findOne({ _id: resetId, accountType: 'employee', expiresAt: { $gt: new Date() }, verifiedAt: null, usedAt: null }).select('+codeHash').lean()
    if (!reset || reset.attempts >= 5 || !resetCodeMatches(resetId, code, reset.codeHash)) {
      if (reset) await CustomerPasswordReset.updateOne({ _id: resetId }, { $inc: { attempts: 1 } })
      return res.status(400).json({ message: 'This verification code is invalid or expired' })
    }
    await CustomerPasswordReset.updateOne({ _id: resetId }, { $set: { verifiedAt: new Date() } })
    return res.json({ verified: true })
  } catch (error) {
    console.error('Employee password reset verification failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to verify password reset code')
  }
})
app.post('/api/auth/forgot-password/reset', passwordResetRateLimit, requireDatabase, async (req, res) => {
  const resetId = String(req.body.resetId || '').trim()
  const password = String(req.body.password || '')
  const confirmPassword = String(req.body.confirmPassword || '')
  if (!/^[a-f0-9]{48}$/.test(resetId)) return res.status(400).json({ message: 'Your password reset session is invalid' })
  if (!password || !confirmPassword) return res.status(400).json({ message: 'Enter and confirm your new password' })
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' })
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
  try {
    const reset = await CustomerPasswordReset.findOneAndUpdate({ _id: resetId, accountType: 'employee', expiresAt: { $gt: new Date() }, verifiedAt: { $ne: null }, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true }).lean()
    if (!reset) return res.status(400).json({ message: 'Your password reset session is invalid or expired' })
    const employee = await Employee.findOneAndUpdate({ _id: reset.employeeId, emailAddress: reset.emailAddress, status: 'Active' }, { $set: { password: hashEmployeePassword(password) } }, { new: true }).lean()
    if (!employee) return res.status(404).json({ message: 'Employee account not found' })
    await CustomerPasswordReset.deleteOne({ _id: resetId })
    return res.json({ reset: true })
  } catch (error) {
    console.error('Employee password reset failed:', error.message)
    return sendDatabaseError(res, error, 'Unable to update your password')
  }
})
app.get('/api/customer-auth/me', requireCustomer, (req, res) => res.json({ customer: req.customer }))
app.post('/api/customer-auth/logout', async (req, res) => {
  const token = readCookie(req, 'omni_customer_session')
  if (token && databaseState()) {
    try {
      const tokenHash = hashCustomerSessionToken(token)
      await CustomerSession.updateOne({ tokenHash }, { $set: { status: 'revoked', revokedAt: new Date(), expiresAt: new Date() } })
    } catch (error) {
      return sendDatabaseError(res, error, 'Unable to sign out')
    }
  } else if (token && process.env.MONGODB_URI) {
    return sendDatabaseError(res, databaseUnavailableError(), 'Unable to sign out')
  }
  clearCustomerCookie(res)
  res.status(204).end()
})

app.use('/api/community', createCommunityRouter({ express, mongoose, multer, uploadDirectory, readWithRetry, databaseState, sendDatabaseError, requireCustomer, findCustomerSessionRecord }))

app.post('/api/auth/login', requireDatabase, async (req, res) => {
  const emailAddress = String(req.body.emailAddress || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  if (!emailAddress || !password) return res.status(400).json({ message: 'Email and password are required' })
  let failureStage = 'employee_lookup'
  try {
    const employee = await readWithRetry('employee-login', () => Employee.findOne({ emailAddress, status: 'Active' }).select('+password').lean())
    failureStage = 'password_verification'
    if (!employee || !employee.password || !passwordMatches(password, employee.password)) return res.status(401).json({ message: 'Invalid employee credentials' })
    failureStage = 'employee_session_creation'
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, { _id: employee._id, fullName: employee.fullName, emailAddress: employee.emailAddress, designation: employee.designation })
    return res.json({ token, employee: sessions.get(token) })
  } catch (error) {
    logAuthenticationFailure('POST /api/auth/login', failureStage, error)
    return sendDatabaseError(res, error, 'Unable to log in')
  }
})
app.get('/api/auth/me', requireAdmin, (req, res) => res.json({ employee: req.employee }))
app.get('/api/auth/profile', requireAdmin, async (req, res) => {
  try {
    if (!databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to load employee profile')
    const employee = await Employee.findOne({ _id: req.employee?._id, status: 'Active' }).select('-password -__v').lean()
    if (!employee) return res.status(404).json({ message: 'Employee profile not found' })
    return res.json({ employee })
  } catch (error) { return sendDatabaseError(res, error, 'Unable to load employee profile') }
})
app.put('/api/auth/change-password', requireAdmin, async (req, res) => {
  const password = String(req.body.password || '')
  const confirmPassword = String(req.body.confirmPassword || '')
  if (!password || !confirmPassword) return res.status(400).json({ message: 'Enter and confirm your new password' })
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' })
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })
  try {
    if (!databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to update password')
    const passwordHash = hashEmployeePassword(password)
    const employee = await Employee.findOneAndUpdate({ _id: req.employee?._id, status: 'Active' }, { $set: { password: passwordHash } }, { new: true }).select('-password -__v').lean()
    if (!employee) return res.status(404).json({ message: 'Employee profile not found' })
    return res.json({ message: 'Password updated successfully' })
  } catch (error) { return sendDatabaseError(res, error, 'Unable to update password') }
})
app.post('/api/auth/logout', requireAdmin, (req, res) => { const token = req.header('authorization')?.replace(/^Bearer\s+/i, ''); sessions.delete(token); return res.status(204).end() })

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'omni-ra-labs-api', databaseReady: databaseState() }))
app.get('/api/health/ready', (_req, res) => {
  if (databaseState()) return res.json({ status: 'ready', service: 'omni-ra-labs-api', databaseReady: true })
  scheduleMongoReconnect()
  res.set('Retry-After', '1')
  return res.status(503).json({ status: 'not_ready', service: 'omni-ra-labs-api', databaseReady: false, retryable: true })
})
app.use('/api/categories', requireDatabase)
app.use('/api/products', requireDatabase)
app.use('/api/vendors', requireDatabase)
app.use('/api/customers', requireDatabase)
app.use('/api/employees', requireDatabase)
app.use('/api/dashboard', requireDatabase)
app.get('/api/categories', requireDatabase, async (req, res) => {
  try {
    const key = cacheKey('categories', req.originalUrl)
    const cached = await readCache(key)
    if (cached) return res.json(cached)
    const page = Math.max(Number(req.query.page) || 1, 1)
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100)
    if (mongoConnected) {
      const filter = { status: 'Active' }
      const [rows, total] = await readWithRetry('categories', () => Promise.all([
        Category.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Category.countDocuments(filter)
      ]))
      const counts = await readWithRetry('category-product-counts', () => Product.aggregate([{ $match: { category: { $in: rows.map((row) => row.name) } } }, { $group: { _id: '$category', count: { $sum: 1 } } }]))
      const countByName = new Map(counts.map((item) => [item._id, item.count]))
      const result = { data: rows.map((row) => ({ ...row, productCount: countByName.get(row.name) || 0 })), page, limit, total, pages: Math.ceil(total / limit) }
      await writeCache(key, result, cacheTtl.categories)
      return res.json(result)
    }
    const activeCategories = sortNewest(categories.filter((category) => category.status === 'Active'))
    const start = (page - 1) * limit
    const countByName = products.reduce((counts, product) => { counts[product.category] = (counts[product.category] || 0) + 1; return counts }, {})
    const result = { data: activeCategories.slice(start, start + limit).map((category) => ({ ...category, productCount: countByName[category.name] || 0 })), page, limit, total: activeCategories.length, pages: Math.ceil(activeCategories.length / limit) }
    await writeCache(key, result, cacheTtl.categories)
    return res.json(result)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to load categories') }
})
app.post('/api/categories', requireAdmin, async (req, res) => { const { name = '', description = '', status = 'Active', image = '/1.jpeg' } = req.body; if (!name.trim() || !description.trim()) return res.status(400).json({ message: 'Name and description are required' }); const category = { name: name.trim(), slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: description.trim(), status, image }; try { if (mongoConnected) return res.status(201).json(await Category.create(category)); const fallbackCategory = { ...category, _id: `c${Date.now()}`, createdAt: new Date().toISOString() }; categories.push(fallbackCategory); return res.status(201).json(fallbackCategory) } catch (error) { if (error.code === 11000) return res.status(409).json({ message: 'A category with this name already exists' }); return sendDatabaseError(res, error, 'Unable to create category') } })
app.post('/api/categories/upload', requireAdmin, (req, res) => categoryImageUpload.single('image')(req, res, async (error) => { if (error || !req.file) return res.status(400).json({ message: error?.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : 'A valid image file is required' }); const { name = '', description = '' } = req.body; if (!name.trim() || !description.trim()) { await fs.promises.unlink(req.file.path); return res.status(400).json({ message: 'Name and description are required' }) } const category = { name: name.trim(), slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: description.trim(), status: 'Active', image: `/uploads/${req.file.filename}` }; try { if (databaseState()) return res.status(201).json(await Category.create(category)); if (process.env.MONGODB_URI) { await fs.promises.unlink(req.file.path).catch(() => { }); return sendDatabaseError(res, databaseUnavailableError(), 'Unable to create category') } const fallbackCategory = { ...category, _id: `c${Date.now()}`, createdAt: new Date().toISOString() }; categories.push(fallbackCategory); return res.status(201).json(fallbackCategory) } catch (saveError) { await fs.promises.unlink(req.file.path).catch(() => { }); if (saveError.code === 11000) return res.status(409).json({ message: 'A category with this name already exists' }); return sendDatabaseError(res, saveError, 'Unable to create category') } }))
const updateCategory = (req, res) => categoryImageUpload.single('image')(req, res, async (error) => { if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 400 : 415).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : 'A valid image file is required' }); const { name = '', description = '' } = req.body; if (!name.trim() || !description.trim()) { if (req.file) await fs.promises.unlink(req.file.path).catch(() => { }); return res.status(400).json({ message: 'Name and description are required' }) } const changes = { name: name.trim(), slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: description.trim() }; if (req.file) changes.image = `/uploads/${req.file.filename}`; try { if (databaseState()) { const existing = await Category.findById(req.params.id).lean(); if (!existing) { await removeStoredImage(changes.image); return res.status(404).json({ message: 'Category not found' }) } const category = await Category.findByIdAndUpdate(req.params.id, changes, { new: true, runValidators: true }).lean(); if (existing.name !== category.name) await Product.updateMany({ category: existing.name }, { $set: { category: category.name } }); if (req.file && existing.image !== category.image) await removeStoredImage(existing.image); return res.json(category) } if (process.env.MONGODB_URI) { if (req.file) await removeStoredImage(changes.image); return sendDatabaseError(res, databaseUnavailableError(), 'Unable to update category') } const category = categories.find((item) => item._id === req.params.id); if (!category) { await removeStoredImage(changes.image); return res.status(404).json({ message: 'Category not found' }) } const previousName = category.name; const previousImage = category.image; Object.assign(category, changes); if (previousName !== category.name) products.forEach((product) => { if (product.category === previousName) product.category = category.name }); if (req.file && previousImage !== category.image) await removeStoredImage(previousImage); return res.json(category) } catch (saveError) { if (req.file) await removeStoredImage(changes.image); if (saveError.code === 11000) return res.status(409).json({ message: 'A category with this name already exists' }); return sendDatabaseError(res, saveError, 'Unable to update category') } })
app.put('/api/categories/:id', requireAdmin, updateCategory)
app.delete('/api/categories/:id', requireAdmin, async (req, res) => { try { const category = mongoConnected ? await Category.findById(req.params.id).lean() : categories.find((item) => item._id === req.params.id); if (!category) return res.status(404).json({ message: 'Category not found' }); const productCount = mongoConnected ? await Product.countDocuments({ category: category.name }) : products.filter((product) => product.category === category.name).length; if (productCount) return res.status(409).json({ message: `This category contains ${productCount} product${productCount === 1 ? '' : 's'}. Reassign them before deleting it.` }); if (mongoConnected) await Category.findByIdAndDelete(req.params.id); else categories = categories.filter((item) => item._id !== req.params.id); await removeStoredImage(category.image); return res.status(204).end() } catch (error) { return sendDatabaseError(res, error, 'Unable to delete category') } })
app.get('/api/vendors', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const page = Math.max(Number(req.query.page) || 1, 1)
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const filter = { status: 'Active' }
      const [data, total] = await Promise.all([
        Vendor.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-__v').lean(),
        Vendor.countDocuments(filter)
      ])
      return res.json({ data, page, limit, total, pages: Math.ceil(total / limit) })
    }
    return res.json(pageResult(vendors.filter((vendor) => vendor.status === 'Active'), req))
  } catch (error) { return sendDatabaseError(res, error, 'Unable to load vendors') }
})
app.post('/api/vendors', requireAdmin, async (req, res) => {
  const fields = ['ownerName', 'registeredBusinessName', 'registeredBusinessAddress', 'registeredPhoneNumber', 'registeredEmailAddress', 'category']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All vendor fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.registeredEmailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.registeredPhoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  try {
    const categoryExists = mongoConnected ? await Category.exists({ name: values.category, status: 'Active' }) : categories.some((category) => category.name === values.category && category.status === 'Active')
    if (!categoryExists) return res.status(400).json({ message: 'Select an active category' })
    if (mongoConnected) return res.status(201).json(await Vendor.create(values))
    const vendor = { ...values, _id: `v${Date.now()}`, status: 'Active', createdAt: new Date().toISOString() }
    vendors.unshift(vendor)
    return res.status(201).json(vendor)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to create vendor') }
})
app.put('/api/vendors/:id', requireAdmin, async (req, res) => {
  const fields = ['ownerName', 'registeredBusinessName', 'registeredBusinessAddress', 'registeredPhoneNumber', 'registeredEmailAddress', 'category']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All vendor fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.registeredEmailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.registeredPhoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  try {
    const categoryExists = mongoConnected ? await Category.exists({ name: values.category, status: 'Active' }) : categories.some((category) => category.name === values.category && category.status === 'Active')
    if (!categoryExists) return res.status(400).json({ message: 'Select an active category' })
    if (mongoConnected) {
      const vendor = await Vendor.findOneAndUpdate({ _id: req.params.id, status: 'Active' }, values, { new: true, runValidators: true }).select('-__v').lean()
      if (!vendor) return res.status(404).json({ message: 'Vendor not found' })
      return res.json(vendor)
    }
    const vendor = vendors.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' })
    Object.assign(vendor, values)
    return res.json(vendor)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to update vendor') }
})
app.delete('/api/vendors/:id', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const vendor = await Vendor.findOneAndDelete({ _id: req.params.id, status: 'Active' })
      if (!vendor) return res.status(404).json({ message: 'Vendor not found' })
      return res.status(204).end()
    }
    const vendor = vendors.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' })
    vendor.status = 'Inactive'
    return res.status(204).end()
  } catch (error) { return sendDatabaseError(res, error, 'Unable to delete vendor') }
})
app.get('/api/customers', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const page = Math.max(Number(req.query.page) || 1, 1)
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const filter = { status: 'Active' }
      const [data, total] = await Promise.all([
        Customer.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-__v').lean(),
        Customer.countDocuments(filter)
      ])
      return res.json({ data, page, limit, total, pages: Math.ceil(total / limit) })
    }
    return res.json(pageResult(customers.filter((customer) => customer.status === 'Active'), req))
  } catch (error) { return sendDatabaseError(res, error, 'Unable to load customers') }
})
app.post('/api/customers', requireAdmin, async (req, res) => {
  const fields = ['customerName', 'phoneNumber', 'emailAddress']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All customer fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  try {
    if (mongoConnected) return res.status(201).json(await Customer.create(values))
    const customer = { ...values, _id: `cu${Date.now()}`, status: 'Active', createdAt: new Date().toISOString() }
    customers.unshift(customer)
    return res.status(201).json(customer)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to create customer') }
})
app.put('/api/customers/:id', requireAdmin, async (req, res) => {
  const fields = ['customerName', 'phoneNumber', 'emailAddress']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All customer fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  try {
    if (mongoConnected) {
      const customer = await Customer.findOneAndUpdate({ _id: req.params.id, status: 'Active' }, values, { new: true, runValidators: true }).select('-__v').lean()
      if (!customer) return res.status(404).json({ message: 'Customer not found' })
      return res.json(customer)
    }
    const customer = customers.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!customer) return res.status(404).json({ message: 'Customer not found' })
    Object.assign(customer, values)
    return res.json(customer)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to update customer') }
})
app.delete('/api/customers/:id', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const customer = await Customer.findOneAndDelete({ _id: req.params.id, status: 'Active' })
      if (!customer) return res.status(404).json({ message: 'Customer not found' })
      return res.status(204).end()
    }
    const customer = customers.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!customer) return res.status(404).json({ message: 'Customer not found' })
    customer.status = 'Inactive'
    return res.status(204).end()
  } catch (error) { return sendDatabaseError(res, error, 'Unable to delete customer') }
})
app.get('/api/employees', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const page = Math.max(Number(req.query.page) || 1, 1)
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const filter = { status: 'Active' }
      const [data, total] = await Promise.all([
        Employee.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-password -__v').lean(),
        Employee.countDocuments(filter)
      ])
      return res.json({ data, page, limit, total, pages: Math.ceil(total / limit) })
    }
    return res.json(pageResult(employees.filter((employee) => employee.status === 'Active'), req))
  } catch (error) { return sendDatabaseError(res, error, 'Unable to load employees') }
})
app.post('/api/employees', requireAdmin, async (req, res) => {
  const fields = ['fullName', 'fatherName', 'cnic', 'phoneNumber', 'emailAddress', 'password', 'confirmPassword', 'address', 'designation']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All employee fields are required' })
  if (values.password !== values.confirmPassword) return res.status(400).json({ message: 'Passwords do not match' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  if (!['Admin', 'Employee'].includes(values.designation)) return res.status(400).json({ message: 'Select a valid designation' })
  const employeeValues = { ...values, password: hashEmployeePassword(values.password) }
  delete employeeValues.confirmPassword
  try {
    if (mongoConnected) return res.status(201).json(await Employee.create(employeeValues).then((employee) => { const result = employee.toObject(); delete result.password; return result }))
    const employee = { ...employeeValues, _id: `e${Date.now()}`, status: 'Active', createdAt: new Date().toISOString() }
    const response = { ...employee }
    delete response.password
    employees.unshift(employee)
    return res.status(201).json(response)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to create employee') }
})
app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const fields = ['fullName', 'fatherName', 'cnic', 'phoneNumber', 'emailAddress', 'address', 'designation']
  const values = Object.fromEntries(fields.map((field) => [field, String(req.body[field] || '').trim()]))
  if (fields.some((field) => !values[field])) return res.status(400).json({ message: 'All employee fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(values.phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  if (!['Admin', 'Employee'].includes(values.designation)) return res.status(400).json({ message: 'Select a valid designation' })
  if (req.body.password || req.body.confirmPassword) { if (req.body.password !== req.body.confirmPassword) return res.status(400).json({ message: 'Passwords do not match' }); values.password = hashEmployeePassword(String(req.body.password).trim()) }
  try {
    if (mongoConnected) {
      const employee = await Employee.findOneAndUpdate({ _id: req.params.id, status: 'Active' }, values, { new: true, runValidators: true }).select('-password -__v').lean()
      if (!employee) return res.status(404).json({ message: 'Employee not found' })
      return res.json(employee)
    }
    const employee = employees.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!employee) return res.status(404).json({ message: 'Employee not found' })
    Object.assign(employee, values)
    const response = { ...employee }
    delete response.password
    return res.json(response)
  } catch (error) { return sendDatabaseError(res, error, 'Unable to update employee') }
})
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    if (mongoConnected) {
      const employee = await Employee.findOneAndDelete({ _id: req.params.id, status: 'Active' })
      if (!employee) return res.status(404).json({ message: 'Employee not found' })
      return res.status(204).end()
    }
    const employee = employees.find((item) => item._id === req.params.id && item.status === 'Active')
    if (!employee) return res.status(404).json({ message: 'Employee not found' })
    employee.status = 'Inactive'
    return res.status(204).end()
  } catch (error) { return sendDatabaseError(res, error, 'Unable to delete employee') }
})
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) return res.json({ products: [], categories: [] })
  if (process.env.MONGODB_URI && !databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to search the marketplace')
  try {
    if (databaseState()) {
      const expression = new RegExp(escapeRegex(query), 'i')
      const [productsResult, categoriesResult] = await Promise.all([
        Product.find({ status: { $in: ['Published', 'Active'] }, $or: [{ name: expression }, { title: expression }] }).select('-__v').sort({ createdAt: -1 }).limit(8).lean(),
        Category.find({ status: 'Active', name: expression }).select('_id name slug image').sort({ name: 1 }).limit(8).lean()
      ])
      return res.json({ products: productsResult.map(normalizeProduct), categories: categoriesResult })
    }
    const lowerQuery = query.toLowerCase()
    return res.json({ products: products.filter((item) => item.status === 'Active' && (item.name || '').toLowerCase().includes(lowerQuery)).slice(0, 8), categories: categories.filter((item) => item.status === 'Active' && item.name.toLowerCase().includes(lowerQuery)).slice(0, 8) })
  } catch (error) { return sendDatabaseError(res, error, 'Unable to search the marketplace') }
})
const geminiModel = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
const geminiUrl = (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`
const geminiRequest = async (model, body) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured')
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(geminiUrl(model, apiKey), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) {
      const result = await response.json()
      return result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || ''
    }
    const details = await response.text()
    lastError = new Error(`Gemini returned ${response.status}: ${details.slice(0, 1000)}`)
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw lastError
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
  }
  throw lastError
}
const geminiEmbedding = async (text) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured')
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbeddingModel}:embedContent?key=${encodeURIComponent(apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY' }) })
  if (!response.ok) { const details = await response.text(); throw new Error(`Gemini embeddings returned ${response.status}: ${details.slice(0, 1000)}`) }
  const result = await response.json()
  return result.embedding?.values || []
}
const parseGeminiJson = (text) => JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, ''))
const chatProductContext = (items) => items.slice(0, 4).map((product) => ({ id: String(product._id), title: product.title || product.name, category: product.category, price: product.price || '', moq: product.moq || '', description: product.shortDescription || product.description || '', status: product.status, image: product.image || product.images?.[0] || '', link: `/products/${product._id}` }))
const chatHistory = (history) => Array.isArray(history) ? history.slice(-12).filter((item) => item && ['user', 'assistant'].includes(item.role)).map((item) => ({ role: item.role, text: String(item.text || '').slice(0, 1000), products: item.role === 'assistant' && Array.isArray(item.products) ? item.products.slice(0, 4).map((product) => ({ id: String(product.id || ''), title: String(product.title || '').slice(0, 160), price: String(product.price || '').slice(0, 40), moq: String(product.moq || '').slice(0, 40) })) : [] })) : []
const lastShownProducts = (history) => [...chatHistory(history)].reverse().find((item) => item.role === 'assistant' && item.products.length)?.products || []
const isProductFollowUp = (message) => /^(?:moq|price|cost|how much|how many|minimum order|minimum order quantity|what(?:'s| is) (?:the )?(?:price|moq|cost)|what is its (?:price|moq)|its (?:price|moq)|قیمت|最低起订量|价格)\s*[?.!]*$/i.test(String(message || '').trim()) || /\b(?:its|this|that|same product)\b.*\b(?:price|moq|cost|quantity)\b/i.test(String(message || ''))
const normalizeSearchText = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const productSearchText = (product) => [product.name, product.title, product.category, product.subcategory, product.shortDescription, product.description, product.specifications, product.specs, product.tags, product.keywords].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ')
const productSearchScore = (product, query) => {
  const normalizedQuery = normalizeSearchText(query)
  const normalizedName = normalizeSearchText(product.name || product.title)
  const normalizedText = normalizeSearchText(productSearchText(product))
  if (!normalizedQuery || !normalizedName) return 0
  if (normalizedName === normalizedQuery) return 1000
  if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) return 700
  const queryTerms = new Set(normalizedQuery.split(/\s+/).filter((term) => term.length > 1))
  const textTerms = new Set(normalizedText.split(/\s+/))
  const overlap = [...queryTerms].filter((term) => textTerms.has(term)).length
  return overlap ? 100 + (overlap / queryTerms.size) * 100 : 0
}
const searchChatProducts = async (plan, customerMessage, shownProducts = []) => {
  if (shownProducts.length && isProductFollowUp(customerMessage)) {
    const ids = shownProducts.map((product) => String(product.id)).filter(Boolean)
    if (mongoConnected && ids.length) {
      const items = await Product.find({ _id: { $in: ids }, status: { $in: ['Published', 'Active'] } }).select('-__v -embedding').lean()
      const byId = new Map(items.map((item) => [String(item._id), item]))
      return ids.map((id) => byId.get(id)).filter(Boolean).map(normalizeProduct)
    }
    return shownProducts.map((product) => ({ ...product, _id: product.id, name: product.title, title: product.title }))
  }
  if (!plan.requires_retrieval) return []
  const queries = [...new Set([customerMessage, plan.retrieval_query].map((value) => String(value || '').trim()).filter(Boolean))]
  const query = queries.join(' ')
  const terms = [...new Set(normalizeSearchText(query).split(/\s+/).filter((term) => term.length > 1))].slice(0, 16)
  if (mongoConnected) {
    const activeFilter = { status: { $in: ['Published', 'Active'] } }
    const exactExpressions = queries.map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i'))
    const exactItems = await Product.find({ ...activeFilter, $or: exactExpressions.flatMap((expression) => [{ name: expression }, { title: expression }]) }).select('-__v -embedding').limit(4).lean()
    const normalizedExpressions = queries.map((value) => new RegExp(escapeRegex(normalizeSearchText(value).replace(/\s+/g, '.*')), 'i'))
    const exactNormalizedItems = exactItems.length ? exactItems : await Product.find({ ...activeFilter, $or: normalizedExpressions.flatMap((expression) => [{ name: expression }, { title: expression }]) }).select('-__v -embedding').limit(4).lean()
    const candidateMap = new Map(exactNormalizedItems.map((item) => [String(item._id), { item, score: productSearchScore(item, query) }]))
    if (process.env.MONGODB_VECTOR_INDEX) {
      try {
        const embedding = await geminiEmbedding(query || plan.category || 'marketplace products')
        if (embedding.length) {
          const vectorItems = await Product.aggregate([{ $vectorSearch: { index: process.env.MONGODB_VECTOR_INDEX, path: 'embedding', queryVector: embedding, numCandidates: 80, limit: 12, filter: activeFilter } }, { $project: { __v: 0, embedding: 0, score: { $meta: 'vectorSearchScore' } } }])
          vectorItems.forEach((item) => { const score = productSearchScore(item, query); const current = candidateMap.get(String(item._id)); candidateMap.set(String(item._id), { item, score: Math.max(score, current?.score || 0) + (item.score || 0) * 100 }) })
        }
      } catch (error) { console.error('Vector retrieval unavailable, using catalog fallback:', error.message) }
    }
    const expression = terms.length ? new RegExp(terms.map(escapeRegex).join('|'), 'i') : null
    const categoryFilter = plan.category ? { category: new RegExp(escapeRegex(plan.category), 'i') } : {}
    const filter = { ...activeFilter, ...categoryFilter, ...(expression && !plan.broad_category ? { $or: [{ name: expression }, { title: expression }, { category: expression }, { shortDescription: expression }, { description: expression }, { subcategory: expression }, { tags: expression }, { keywords: expression }] } : {}) }
    let lexicalItems = await Product.find(filter).select('-__v -embedding').sort({ createdAt: -1, _id: -1 }).limit(16).lean()
    if (!lexicalItems.length && plan.category) {
      const uncategorizedFilter = { ...activeFilter, ...(expression && !plan.broad_category ? { $or: [{ name: expression }, { title: expression }, { category: expression }, { shortDescription: expression }, { description: expression }, { subcategory: expression }, { tags: expression }, { keywords: expression }] } : {}) }
      lexicalItems = await Product.find(uncategorizedFilter).select('-__v -embedding').sort({ createdAt: -1, _id: -1 }).limit(16).lean()
    }
    lexicalItems.forEach((item) => { const score = productSearchScore(item, query); const current = candidateMap.get(String(item._id)); candidateMap.set(String(item._id), { item, score: Math.max(score, current?.score || 0) }) })
    if (!candidateMap.size && plan.category) {
      const categoryItems = await Product.find({ ...activeFilter, category: new RegExp(escapeRegex(plan.category), 'i') }).select('-__v -embedding').sort({ createdAt: -1, _id: -1 }).limit(12).lean()
      categoryItems.forEach((item) => candidateMap.set(String(item._id), { item, score: 50 }))
    }
    return [...candidateMap.values()].sort((left, right) => right.score - left.score).slice(0, 12).map(({ item }) => normalizeProduct(item))
  }
  return products.filter((product) => ['Active', 'Published'].includes(product.status) && (!plan.category || product.category.toLowerCase() === plan.category.toLowerCase()) && (plan.broad_category || !terms.length || terms.some((term) => productSearchText(product).toLowerCase().includes(term)))).sort((left, right) => productSearchScore(right, query) - productSearchScore(left, query)).slice(0, 12).map(normalizeProduct)
}
const saveContactRequest = async ({ firstName, phoneNumber, email, message, idempotencyKey = '', source = '' }) => {
  if (!mongoConnected) throw new Error('Contact Requests database is unavailable')
  if (idempotencyKey) {
    const existing = await ContactRequest.findOne({ idempotencyKey }).lean()
    if (existing) return { record: existing, created: false }
  }
  try {
    const contactRequestData = { customerName: firstName.trim(), phoneNumber: phoneNumber.trim(), email: email.trim(), message: message.trim(), status: 'New', submittedAt: new Date(), ...(source ? { source } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }
    const record = await ContactRequest.create(contactRequestData)
    await emitBadgeChange('contact.changed', normalizeNotification('Contact Request', record.toObject ? record.toObject() : record, true))
    return { record: record.toObject ? record.toObject() : record, created: true }
  } catch (error) {
    if (idempotencyKey && error.code === 11000) {
      const existing = await ContactRequest.findOne({ idempotencyKey }).lean()
      if (existing) return { record: existing, created: false }
    }
    throw error
  }
}
const sourcingFlowResponse = async (state, message, introduction = false) => {
  const nextField = nextSourcingField(state.fields)
  if (nextField) {
    const invalid = nextField === state.lastAnsweredField && message && (
      (nextField === 'customerName' && String(message).trim().length > 160) ||
      (nextField === 'quantity' && String(message).trim().length > 80) ||
      (nextField === 'targetPrice' && String(message).trim().length > 80) ||
      (nextField === 'phoneNumber' && !sourcingPhonePattern.test(String(message).trim())) ||
      (nextField === 'email' && (String(message).trim().length > 254 || !sourcingEmailPattern.test(String(message).trim())))
    )
    const question = sourcingQuestion(nextField)
    const lead = introduction ? `We'd be happy to source ${state.fields.product} for you through our vendors. ` : ''
    const correction = invalid ? ({
      customerName: 'Please keep your name to 160 characters or fewer. ',
      quantity: 'Please share a quantity under 80 characters. ',
      targetPrice: 'Please share a target price under 80 characters. ',
      phoneNumber: 'Please enter a valid phone number. ',
      email: 'Please enter a valid email address. '
    }[nextField]) : ''
    return { reply: `${lead}${correction}${question}`, products: [], sourcingState: { ...state, askedField: nextField } }
  }

  const fields = state.fields
  if (!fields.product || !fields.customerName || !fields.quantity || !fields.targetPrice || !sourcingPhonePattern.test(fields.phoneNumber) || !sourcingEmailPattern.test(fields.email)) {
    const field = !fields.phoneNumber || !sourcingPhonePattern.test(fields.phoneNumber) ? 'phoneNumber' : 'email'
    return { reply: sourcingQuestion(field), products: [], sourcingState: { ...state, askedField: field } }
  }
  if (!/^[0-9a-f-]{36}$/i.test(state.requestId || '')) return { reply: 'I could not submit that request just now. Please try again.', products: [], sourcingState: state }
  try {
    await saveContactRequest({
      firstName: fields.customerName,
      phoneNumber: fields.phoneNumber,
      email: fields.email,
      message: formatSourcingContactMessage({ ...fields, details: state.details }),
      idempotencyKey: state.requestId,
      source: 'Ricky/AI'
    })
    const submittedState = { ...state, submitted: true, submittedMessage: String(message || '').slice(0, 1000) }
    return { reply: `Thanks, ${fields.customerName}. I've sent your sourcing request to our team, and they will be in touch.`, products: [], sourcingState: submittedState }
  } catch (error) {
    console.error('Ricky sourcing request could not be saved:', error.message)
    return { reply: 'I could not submit that request just now. Your details are still here; please try again shortly.', products: [], sourcingState: state }
  }
}
const callShoppingAgent = async ({ message, history, image, sourcingState }) => {
  const imagePart = image ? { inlineData: { mimeType: image.mimetype, data: image.buffer.toString('base64') } } : null
  const shownProducts = lastShownProducts(history)
  const intentText = await geminiRequest(geminiModel, { systemInstruction: { parts: [{ text: 'You are the intent and retrieval planner for a real B2B marketplace shopping agent. Understand the customer in any language or script, including Hindi, Urdu, Roman Urdu, Punjabi, Sindhi, Pashto, Chinese, Japanese, French, and other supported languages, and never answer the customer yet. First decide whether the customer is asking to speak with a human, live agent, customer support representative, vendor, sales representative, or another real person. Detect meaning and paraphrases, not exact keywords: requests such as needing human support, being connected to a person, speaking with someone, or contacting sales all count even when translated or written in another script. Set human_handoff true only when the customer clearly wants human assistance or wants to be connected to a person; do not set it for unrelated mentions of humans, support, vendors, sales, or agents. When human_handoff is true, stop deciding catalog retrieval and do not infer or summarize the request. Otherwise decide whether the marketplace catalog is needed. Product names, product categories, price, MOQ, availability, recommendations, comparisons, and ordering always require retrieval. For terse follow-ups such as price, MOQ, cost, or its price, use last_shown_products as the product reference and set requires_retrieval true. Broad category-only requests should set broad_category true, requires_retrieval true, and ask for a product type while allowing representative examples. Set retrieval_query to a concise normalized search query including English product synonyms when the customer uses another language or script. Return only valid JSON with: language, intent, human_handoff, requires_retrieval, broad_category, retrieval_query, category, action, needs_clarification.' }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify({ message, history: chatHistory(history), last_shown_products: shownProducts }) }, ...(imagePart ? [imagePart] : [])] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } })
  const plan = parseGeminiJson(intentText)
  if (plan.human_handoff === true || String(plan.human_handoff).toLowerCase() === 'true') return { humanHandoff: true, reply: '', products: [] }
  let candidates = null
  if (sourcingState) {
    if (sourcingState.submitted) {
      if (String(message || '').trim() === sourcingState.submittedMessage) return { reply: 'Your sourcing request has already been sent to our team.', products: [], sourcingState }
      sourcingState = null
    } else if (plan.requires_retrieval && !isProductFollowUp(message)) {
      candidates = await searchChatProducts(plan, message, shownProducts)
      const retrievalQuery = String(plan.retrieval_query || '').trim()
      if (hasRelevantActiveProduct(candidates, retrievalQuery, productSearchScore)) sourcingState = null
      else {
        const updatedState = retrievalQuery ? { ...sourcingState, fields: { ...sourcingState.fields, product: retrievalQuery.slice(0, 160) } } : sourcingState
        return sourcingFlowResponse(updateSourcingState(updatedState, message), message)
      }
    } else {
      return sourcingFlowResponse(updateSourcingState(sourcingState, message), message)
    }
  }
  candidates ||= await searchChatProducts(plan, message, shownProducts)
  const retrievalQuery = String(plan.retrieval_query || '').trim()
  if (plan.requires_retrieval && !plan.broad_category && retrievalQuery && !isProductFollowUp(message) && !hasRelevantActiveProduct(candidates, retrievalQuery, productSearchScore)) {
    const initialState = createSourcingState({ message, product: retrievalQuery, requestId: crypto.randomUUID() })
    return sourcingFlowResponse(initialState, message, true)
  }
  const candidateContext = JSON.stringify(candidates.slice(0, 12).map((product) => ({ id: String(product._id), title: product.title || product.name, category: product.category, price: product.price || '', moq: product.moq || '', description: product.shortDescription || product.description || '', image: product.image || product.images?.[0] || '', link: `/products/${product._id}` })))
  const answerText = await geminiRequest(geminiModel, { systemInstruction: { parts: [{ text: 'You are Shopping Chat, a warm and precise B2B marketplace agent. Respond in the customer language/script identified by the planner. The marketplace records below are the only source of truth for product facts. Do not invent price, MOQ, availability, links, or product details. Use no more than four products. For broad category requests, ask which product type they need and optionally mention a few representative records. For ordering requests, identify the relevant record and tell the customer to open its product link and click Send Inquiry. Return only valid JSON with reply (string) and product_ids (array of ids from the records). Greetings and general help should be answered naturally without product cards.' }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify({ message, history: chatHistory(history), planner: plan, retrieved_marketplace_records: candidateContext }) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.35 } })
  const answer = parseGeminiJson(answerText)
  const validIds = new Set(candidates.map((product) => String(product._id)))
  const selected = (Array.isArray(answer.product_ids) ? answer.product_ids : []).filter((id) => validIds.has(String(id))).slice(0, 4)
  const selectedProducts = selected.length ? candidates.filter((product) => selected.includes(String(product._id))) : candidates.slice(0, plan.broad_category ? 3 : 4)
  return { reply: String(answer.reply || ''), products: chatProductContext(selectedProducts) }
}
app.post('/api/shopping-chat', shoppingChatRateLimit, chatImageUpload.single('image'), async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 1000)
  if (!message && !req.file) return res.status(400).json({ message: 'Add a message or image to start the chat' })
  try {
    const history = req.body.history ? JSON.parse(String(req.body.history)) : []
    const sourcingState = req.body.sourcingState ? JSON.parse(String(req.body.sourcingState)) : null
    const result = await callShoppingAgent({ message: message || 'Find products similar to this image.', history, image: req.file, sourcingState })
    return res.json(result)
  } catch (error) { console.error('Shopping chat failed:', error.message); return sendDatabaseError(res, error, 'Shopping Chat is temporarily unavailable') }
})
app.get('/api/products', async (req, res) => {
  try {
    const query = String(req.query.search || '').toLowerCase()
    const category = String(req.query.category || '')
    const status = ''
    const sortMode = String(req.query.sort || 'newest').trim().toLowerCase()
    const key = cacheKey('products', req.originalUrl)
    const cached = await readCache(key)
    if (cached) return res.json(cached)
    const page = Math.max(Number(req.query.page) || 1, 1); const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    const filter = { ...(category && { category }), ...(status && { status }), ...(query && { $or: [{ name: { $regex: escapeRegex(query), $options: 'i' } }, { title: { $regex: escapeRegex(query), $options: 'i' } }] }) }
    if (mongoConnected) {
      if (sortMode === 'hot-selling') {
        const [items, total] = await readWithRetry('products-hot-selling', () => Promise.all([
          Product.aggregate([
            { $match: filter },
            {
              $lookup: {
                from: 'inquiries',
                let: { productId: { $toString: '$_id' } },
                pipeline: [
                  { $match: { $expr: { $eq: ['$productId', '$$productId'] } } },
                  { $group: { _id: '$productId', inquiryCount: { $sum: 1 } } }
                ],
                as: 'inquiryStats'
              }
            },
            { $addFields: { inquiryCount: { $ifNull: [{ $arrayElemAt: ['$inquiryStats.inquiryCount', 0] }, 0] } } },
            { $sort: { inquiryCount: -1, createdAt: -1, _id: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $project: { inquiryStats: 0, __v: 0 } }
          ]),
          Product.countDocuments(filter)
        ]))
        const result = { data: items.map(normalizeProduct), page, limit, total, pages: Math.ceil(total / limit) }
        await writeCache(key, result, cacheTtl.products)
        return res.json(result)
      }
      const [items, total] = await readWithRetry('products', () => Promise.all([Product.find(filter).select('-__v').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Product.countDocuments(filter)]))
      const result = { data: items.map(normalizeProduct), page, limit, total, pages: Math.ceil(total / limit) }
      await writeCache(key, result, cacheTtl.products)
      return res.json(result)
    }
    if (process.env.MONGODB_URI) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to load products')
    const result = products.filter((product) => (!category || product.category === category) && (!status || product.status === status) && product.name.toLowerCase().includes(query))
    const ordered = sortProductsForRequest(result, req)
    const pageResultData = pageResult(ordered, req)
    pageResultData.data = pageResultData.data.map(normalizeProduct)
    await writeCache(key, pageResultData, cacheTtl.products)
    return res.json(pageResultData)
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load products')
  }
})
app.get('/api/products/:id', async (req, res) => {
  const key = cacheKey('product', req.params.id)
  const cached = await readCache(key)
  if (cached) return res.json(cached)
  if (databaseState()) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid product id' })
    try {
      const product = await readWithRetry('product-detail', () => Product.findById(req.params.id).select('-__v').lean())
      if (!product) return res.status(404).json({ message: 'Product not found' })
      const result = normalizeProduct(product)
      await writeCache(key, result, cacheTtl.product)
      return res.json(result)
    } catch (error) {
      return sendDatabaseError(res, error, 'Unable to load product')
    }
  }
  if (process.env.MONGODB_URI) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to load product')
  const product = products.find((item) => item._id === req.params.id)
  if (!product) return res.status(404).json({ message: 'Product not found' })
  const result = normalizeProduct(product)
  await writeCache(key, result, cacheTtl.product)
  return res.json(result)
})
const createProduct = (req, res) => productMediaUpload.fields([{ name: 'images', maxCount: 4 }, { name: 'video', maxCount: 1 }])(req, res, async (error) => { const uploaded = Object.values(req.files || {}).flat(); const removeUploads = () => Promise.all(uploaded.map((file) => removeStoredImage(`/uploads/${file.filename}`))); if (error) { await removeUploads(); return res.status(error.code === 'LIMIT_FILE_SIZE' ? 400 : 415).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Media must be within the allowed size' : 'Use supported image and video formats' }) } const { title = '', category = '', shortDescription = '', tiers = '', status = 'Active' } = req.body; let parsedTiers; try { parsedTiers = JSON.parse(tiers) } catch { await removeUploads(); return res.status(400).json({ message: 'Pricing tiers are invalid' }) } if (!title.trim() || !category.trim() || !shortDescription.trim() || !Array.isArray(parsedTiers) || parsedTiers.length !== 4 || parsedTiers.some((tier) => !tier.price?.trim() || !Number.isInteger(Number(tier.moqMin)) || !Number.isInteger(Number(tier.moqMax)) || Number(tier.moqMin) < 1 || Number(tier.moqMax) < Number(tier.moqMin))) { await removeUploads(); return res.status(400).json({ message: 'Title, category, description, and four valid pricing tiers are required' }) } try { if (mongoConnected) { const categoryExists = await Category.exists({ name: category.trim(), status: 'Active' }); if (!categoryExists) { await removeUploads(); return res.status(400).json({ message: 'Select an active category' }) } const imagePaths = (req.files?.images || []).map((file) => `/uploads/${file.filename}`); const videoPath = req.files?.video?.[0] ? `/uploads/${req.files.video[0].filename}` : ''; const product = await Product.create({ name: title.trim(), title: title.trim(), category: category.trim(), shortDescription: shortDescription.trim(), description: shortDescription.trim(), priceTiers: parsedTiers, tiers: parsedTiers, images: imagePaths, image: imagePaths[0] || '/1.jpeg', video: videoPath, status }); return res.status(201).json(product) } if (process.env.MONGODB_URI) { await removeUploads(); return sendDatabaseError(res, databaseUnavailableError(), 'Unable to create product') } const imagePaths = (req.files?.images || []).map((file) => `/uploads/${file.filename}`); const fallbackProduct = { _id: `p${Date.now()}`, name: title.trim(), title: title.trim(), category: category.trim(), shortDescription: shortDescription.trim(), description: shortDescription.trim(), priceTiers: parsedTiers, tiers: parsedTiers, images: imagePaths, image: imagePaths[0] || '/1.jpeg', video: req.files?.video?.[0] ? `/uploads/${req.files.video[0].filename}` : '', status, createdAt: new Date().toISOString() }; products.unshift(fallbackProduct); return res.status(201).json(fallbackProduct) } catch (saveError) { await removeUploads(); return sendDatabaseError(res, saveError, 'Unable to create product') } })
app.post('/api/products', requireAdmin, (req, res) => { const { name, category, price = '', moq = '', status = 'Draft', image = '/1.jpeg' } = req.body; if (!name || !category) return res.status(400).json({ message: 'Product name and category are required' }); const product = { ...req.body, _id: `p${Date.now()}`, name, category, price, moq, status, image, createdAt: new Date().toISOString() }; products.unshift(product); res.status(201).json(product) })
app.post('/api/products/upload', requireAdmin, createProduct)
const updateProduct = (req, res) => productMediaUpload.fields([{ name: 'images', maxCount: 4 }, { name: 'video', maxCount: 1 }])(req, res, async (error) => { const uploaded = Object.values(req.files || {}).flat(); const removeUploads = () => Promise.all(uploaded.map((file) => removeStoredImage(`/uploads/${file.filename}`))); if (error) { await removeUploads(); return res.status(error.code === 'LIMIT_FILE_SIZE' ? 400 : 415).json({ message: 'Use supported image and video formats within the allowed size' }) } const { title = '', category = '', shortDescription = '', tiers = '', existingImages = '[]', existingVideo = '', status = 'Active' } = req.body; let parsedTiers; let keptImages; try { parsedTiers = JSON.parse(tiers); keptImages = JSON.parse(existingImages) } catch { await removeUploads(); return res.status(400).json({ message: 'Product data is invalid' }) } if (!title.trim() || !category.trim() || !shortDescription.trim() || !Array.isArray(parsedTiers) || parsedTiers.length !== 4 || parsedTiers.some((tier) => !tier.price?.trim() || !Number.isInteger(Number(tier.moqMin)) || !Number.isInteger(Number(tier.moqMax)) || Number(tier.moqMin) < 1 || Number(tier.moqMax) < Number(tier.moqMin)) || !Array.isArray(keptImages) || keptImages.length > 4) { await removeUploads(); return res.status(400).json({ message: 'Title, category, description, and four valid pricing tiers are required' }) } try { if (mongoConnected) { const existing = await Product.findById(req.params.id).lean(); if (!existing) { await removeUploads(); return res.status(404).json({ message: 'Product not found' }) } const imagePaths = [...keptImages, ...(req.files?.images || []).map((file) => `/uploads/${file.filename}`)].slice(0, 4); const videoPath = req.files?.video?.[0] ? `/uploads/${req.files.video[0].filename}` : existingVideo; const product = await Product.findByIdAndUpdate(req.params.id, { name: title.trim(), title: title.trim(), category: category.trim(), shortDescription: shortDescription.trim(), description: shortDescription.trim(), priceTiers: parsedTiers, tiers: parsedTiers, images: imagePaths, image: imagePaths[0] || '', video: videoPath, status }, { new: true, runValidators: true }).lean(); await Promise.all([...(existing.images || []), existing.image, existing.video].filter((image) => image && !imagePaths.includes(image) && image !== videoPath).map(removeStoredImage)); return res.json(normalizeProduct(product)) } if (process.env.MONGODB_URI) { await removeUploads(); return sendDatabaseError(res, databaseUnavailableError(), 'Unable to update product') } const product = products.find((item) => item._id === req.params.id); if (!product) { await removeUploads(); return res.status(404).json({ message: 'Product not found' }) } const previousImages = [...(product.images || []), product.image, product.video].filter(Boolean); const imagePaths = [...keptImages, ...(req.files?.images || []).map((file) => `/uploads/${file.filename}`)].slice(0, 4); Object.assign(product, { name: title.trim(), title: title.trim(), category: category.trim(), shortDescription: shortDescription.trim(), description: shortDescription.trim(), priceTiers: parsedTiers, tiers: parsedTiers, images: imagePaths, image: imagePaths[0] || '', video: req.files?.video?.[0] ? `/uploads/${req.files.video[0].filename}` : existingVideo, status }); await Promise.all(previousImages.filter((image) => !imagePaths.includes(image) && image !== product.video).map(removeStoredImage)); return res.json(normalizeProduct(product)) } catch (saveError) { await removeUploads(); return sendDatabaseError(res, saveError, 'Unable to update product') } })
app.put('/api/products/:id', requireAdmin, updateProduct)
app.delete('/api/products/:id', requireAdmin, async (req, res) => { try { if (databaseState()) { const product = await Product.findByIdAndDelete(req.params.id).lean(); if (!product) return res.status(404).json({ message: 'Product not found' }); await Promise.all([...(product.images || []), product.video].filter(Boolean).map(removeStoredImage)); return res.status(204).end() } if (process.env.MONGODB_URI) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to delete product'); const product = products.find((item) => item._id === req.params.id); if (!product) return res.status(404).json({ message: 'Product not found' }); product.status = 'Inactive'; return res.status(204).end() } catch (error) { return sendDatabaseError(res, error, 'Unable to delete product') } })
app.get('/api/dashboard/overview', requireAdmin, async (_req, res) => {
  try {
    if (databaseState()) {
      const [totalProducts, totalCategories, recentProducts, conversationTotal, newInquiries, pendingContactRequests, confirmedOrders, recentInquiries] = await readWithRetry('dashboard-overview', () => Promise.all([
        Product.countDocuments(),
        Category.countDocuments({ status: 'Active' }),
        Product.find().sort({ createdAt: -1, _id: -1 }).limit(4).lean(),
        Conversation.aggregate([{ $group: { _id: null, totalUnread: { $sum: '$unreadCount' } } }]),
        Inquiry.countDocuments({ status: 'New' }),
        ContactRequest.countDocuments({ status: 'New' }),
        Inquiry.countDocuments({ status: 'Order Confirmed' }),
        Inquiry.find().sort({ createdAt: -1, _id: -1 }).limit(5).lean()
      ]))
      const unreadMessages = conversationTotal?.[0]?.totalUnread || 0
      return res.json({ totalProducts, activeProducts: totalProducts, totalCategories, newInquiries, pendingContactRequests, confirmedOrders, unreadMessages, recentProducts: recentProducts.map(normalizeProduct), recentInquiries, recentMessages: [] })
    }
    const unreadMessages = conversations.reduce((sum, conversation) => sum + Number(conversation.unreadCount || 0), 0)
    return res.json({ totalProducts: products.length, activeProducts: products.length, totalCategories: categories.filter((item) => item.status === 'Active').length, newInquiries: inquiries.filter((item) => item.status === 'New').length, pendingContactRequests: 0, confirmedOrders: inquiries.filter((item) => item.status === 'Order Confirmed').length, unreadMessages, recentProducts: products.slice(0, 4), recentInquiries: inquiries.slice(0, 5), recentMessages: [] })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load dashboard overview')
  }
})
app.get('/api/dashboard/badges', requireAdmin, async (_req, res) => {
  try {
    return res.json(await getDashboardBadgeCounts())
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load dashboard badges')
  }
})
app.get('/api/dashboard/notifications', requireAdmin, async (_req, res) => {
  try {
    if (mongoConnected) {
      const [messages, inquiryRecords, contactRecords] = await Promise.all([
        Message.find({ sender: 'customer' }).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
        Inquiry.find().sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
        ContactRequest.find().sort({ createdAt: -1, _id: -1 }).limit(100).lean()
      ])
      return res.json({
        data: [
          ...messages.map((item) => normalizeNotification('Message', item, item.status !== 'read')),
          ...inquiryRecords.map((item) => normalizeNotification('Inquiry', item, item.status === 'New' && !item.readAt)),
          ...contactRecords.map((item) => normalizeNotification('Contact Request', item, item.status === 'New' && !item.readAt))
        ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 100)
      })
    }
    return res.json({
      data: [
        ...conversationMessages.filter((item) => item.sender === 'customer').map((item) => normalizeNotification('Message', item, item.status !== 'read')),
        ...inquiries.map((item) => normalizeNotification('Inquiry', item, item.status === 'New' && !item.readAt))
      ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 100)
    })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load notifications')
  }
})
app.post('/api/dashboard/notifications/read', requireAdmin, async (req, res) => {
  const type = String(req.body.type || '').trim()
  const id = String(req.body.id || '').trim()
  if (!id || !['Inquiry', 'Contact Request'].includes(type)) return res.status(400).json({ message: 'Notification type and id are required' })
  try {
    if (mongoConnected) {
      const Model = type === 'Inquiry' ? Inquiry : ContactRequest
      await Model.updateOne({ _id: id, status: 'New' }, { $set: { readAt: new Date() } })
    } else {
      const collection = type === 'Inquiry' ? inquiries : []
      const item = collection.find((record) => String(record._id) === id)
      if (item) item.readAt = new Date().toISOString()
    }
    await emitBadgeChange(type === 'Inquiry' ? 'inquiry.changed' : 'contact.changed')
    return res.json({ id, type, read: true })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to mark notification as read')
  }
})
app.get('/api/dashboard/message-badge', requireAdmin, async (_req, res) => {
  try {
    const counts = await getDashboardBadgeCounts()
    return res.json({ unreadMessages: counts.unreadMessages })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load message badge')
  }
})
app.get('/api/messages/customers', requireAdmin, async (_req, res) => {
  try {
    if (mongoConnected) {
      const customersData = await Customer.find({ status: 'Active' }).sort({ createdAt: -1, _id: -1 }).lean()
      const customerIds = customersData.map((customer) => String(customer._id))
      const [conversationsData, recentMessages] = await Promise.all([
        Conversation.find({ customerId: { $in: customerIds } }).lean(),
        Message.find({ customerId: { $in: customerIds } }).sort({ createdAt: -1 }).lean()
      ])
      const conversationByCustomer = new Map(conversationsData.map((conversation) => [String(conversation.customerId), conversation]))
      const lastMessageByCustomer = new Map()
      for (const message of recentMessages) {
        const key = String(message.customerId)
        if (!lastMessageByCustomer.has(key)) lastMessageByCustomer.set(key, normalizeMessage(message))
      }
      const data = customersData.map((customer) => {
        const conversation = conversationByCustomer.get(String(customer._id))
        const lastMessage = lastMessageByCustomer.get(String(customer._id))
        const lastMessageText = lastMessage?.text?.trim() || (lastMessage?.attachments?.length ? `Attachment: ${lastMessage.attachments[0].fileName}` : 'No messages yet')
        const unreadCount = conversation?.lastReadByAdminAt && lastMessage?.createdAt && new Date(lastMessage.createdAt).getTime() <= new Date(conversation.lastReadByAdminAt).getTime() ? 0 : conversation?.unreadCount || 0
        return {
          ...customer,
          _id: String(customer._id),
          avatar: (customer.customerName || 'CU').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
          lastMessage: lastMessageText,
          lastMessageAt: conversation?.lastMessageAt || lastMessage?.createdAt || customer.createdAt,
          unreadCount
        }
      }).sort((left, right) => new Date(right.lastMessageAt || 0) - new Date(left.lastMessageAt || 0))
      return res.json({ data })
    }
    const customerList = customers.filter((customer) => customer.status === 'Active').map((customer) => {
      const conversation = conversations.find((item) => String(item.customerId) === String(customer._id))
      const latestMessage = [...conversationMessages.filter((item) => String(item.customerId) === String(customer._id))].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0]
      const lastMessageText = latestMessage?.text?.trim() || (latestMessage?.attachments?.length ? `Attachment: ${latestMessage.attachments[0].fileName}` : 'No messages yet')
      const unreadCount = conversation?.lastReadByAdminAt && latestMessage?.createdAt && new Date(latestMessage.createdAt).getTime() <= new Date(conversation.lastReadByAdminAt).getTime() ? 0 : conversation?.unreadCount || 0
      return {
        ...customer,
        avatar: (customer.customerName || 'CU').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        lastMessage: lastMessageText,
        lastMessageAt: conversation?.lastMessageAt || latestMessage?.createdAt || customer.createdAt,
        unreadCount
      }
    }).sort((left, right) => new Date(right.lastMessageAt || 0) - new Date(left.lastMessageAt || 0))
    return res.json({ data: customerList })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load customer conversations')
  }
})
app.post('/api/messages/read', requireAdmin, async (req, res) => {
  const customerId = String(req.body.customerId || req.query.customerId || '').trim()
  if (!customerId) return res.status(400).json({ message: 'Customer id is required.' })
  try {
    await markCustomerConversationRead(customerId)
    await emitBadgeChange('message.changed')
    return res.json({ customerId, unreadCount: 0 })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to update read state.')
  }
})
app.post('/api/messages/customer/read', requireCustomer, async (req, res) => {
  const customerId = String(req.customer._id)
  try {
    await markAdminConversationRead(customerId)
    await emitBadgeChange('message.changed')
    return res.json({ customerId, unreadCount: 0 })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to update read state.')
  }
})
app.get('/api/messages/customer/unread-count', requireCustomer, async (req, res) => {
  const customerId = String(req.customer._id)
  try {
    if (mongoConnected) {
      const unreadCount = await Message.countDocuments({ customerId, sender: 'admin', status: { $ne: 'read' } })
      return res.json({ customerId, unreadCount })
    }
    const unreadCount = conversationMessages.filter((message) => String(message.customerId) === String(customerId) && String(message.sender) === 'admin' && String(message.status) !== 'read').length
    return res.json({ customerId, unreadCount })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load unread count.')
  }
})
app.get('/api/messages/customer', requireCustomer, async (req, res) => {
  const customerId = String(req.customer._id)
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 10), 50)
  const beforeCreatedAt = String(req.query.beforeCreatedAt || '').trim()
  const beforeId = String(req.query.beforeId || '').trim()
  const cursorDate = beforeCreatedAt ? new Date(beforeCreatedAt) : null
  const hasValidCursor = cursorDate && !Number.isNaN(cursorDate.getTime())
  try {
    if (mongoConnected) {
      const messageFilter = { customerId }
      if (hasValidCursor) {
        messageFilter.$or = [
          { createdAt: { $lt: cursorDate } },
          ...(beforeId ? [{ createdAt: cursorDate, _id: { $lt: beforeId } }] : [])
        ]
      }
      const [customerRecord, records] = await Promise.all([
        Customer.findById(customerId).lean(),
        Message.find(messageFilter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean()
      ])
      if (!customerRecord) return res.status(404).json({ message: 'Customer profile not found' })
      await markAdminConversationRead(customerId)
      const hasMore = records.length > limit
      const page = (hasMore ? records.slice(0, limit) : records).reverse()
      const oldest = page[0]
      return res.json({ customer: { ...customerRecord, _id: String(customerRecord._id) }, messages: page.map((message) => normalizeMessage({ ...message, status: String(message.sender) === 'admin' && String(message.status) !== 'read' ? 'read' : message.status })), hasMore, nextCursor: oldest ? { createdAt: oldest.createdAt, id: String(oldest._id) } : null })
    }
    const customerRecord = customers.find((customer) => String(customer._id) === String(customerId) && customer.status === 'Active')
    if (!customerRecord) return res.status(404).json({ message: 'Customer profile not found' })
    const conversation = conversations.find((item) => String(item.customerId) === String(customerId))
    if (conversation) conversation.unreadCount = 0
    const allRecords = conversationMessages.filter((message) => String(message.customerId) === String(customerId)).sort((left, right) => {
      const timeDifference = new Date(right.createdAt) - new Date(left.createdAt)
      return timeDifference || String(right._id).localeCompare(String(left._id))
    })
    const filteredRecords = hasValidCursor ? allRecords.filter((message) => {
      const messageDate = new Date(message.createdAt)
      return messageDate < cursorDate || (messageDate.getTime() === cursorDate.getTime() && beforeId && String(message._id) < beforeId)
    }) : allRecords
    const hasMore = filteredRecords.length > limit
    const page = (hasMore ? filteredRecords.slice(0, limit) : filteredRecords).reverse()
    const oldest = page[0]
    await markAdminConversationRead(customerId)
    return res.json({ customer: customerRecord, messages: page.map((message) => normalizeMessage({ ...message, status: String(message.sender) === 'admin' && String(message.status) !== 'read' ? 'read' : message.status })), hasMore, nextCursor: oldest ? { createdAt: oldest.createdAt, id: String(oldest._id) } : null })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load your conversation')
  }
})
app.get('/api/messages', requireAdmin, async (req, res) => {
  const customerId = String(req.query.customerId || '').trim()
  if (!customerId) return res.json({ customer: null, messages: [] })
  try {
    if (mongoConnected) {
      const [customerRecord, records] = await Promise.all([
        Customer.findById(customerId).lean(),
        Message.find({ customerId }).sort({ createdAt: 1 }).lean()
      ])
      if (!customerRecord) return res.status(404).json({ message: 'Customer not found' })
      await markCustomerConversationRead(customerId)
      return res.json({ customer: { ...customerRecord, _id: String(customerRecord._id) }, messages: records.map((message) => normalizeMessage({ ...message, status: String(message.sender) === 'customer' && String(message.status) !== 'read' ? 'read' : message.status })) })
    }
    const customerRecord = customers.find((customer) => String(customer._id) === String(customerId) && customer.status === 'Active')
    if (!customerRecord) return res.status(404).json({ message: 'Customer not found' })
    const conversation = conversations.find((item) => String(item.customerId) === String(customerId))
    if (conversation) conversation.unreadCount = 0
    const records = conversationMessages.filter((message) => String(message.customerId) === String(customerId)).sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
    await markCustomerConversationRead(customerId)
    return res.json({ customer: customerRecord, messages: records.map((message) => normalizeMessage({ ...message, status: String(message.sender) === 'customer' && String(message.status) !== 'read' ? 'read' : message.status })) })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to load conversation')
  }
})
app.delete('/api/messages/:id', requireAdmin, async (req, res) => {
  const messageId = String(req.params.id || '').trim()
  if (!messageId) return res.status(400).json({ message: 'Message id is required.' })
  try {
    if (mongoConnected) {
      const message = await Message.findById(messageId).lean()
      if (!message) return res.status(404).json({ message: 'Message not found.' })
      if (String(message.sender) !== 'admin') return res.status(403).json({ message: 'You can only delete your own messages.' })
      await finalizeMessageDeletion(message)
      return res.status(204).end()
    }
    const message = conversationMessages.find((item) => String(item._id) === String(messageId))
    if (!message) return res.status(404).json({ message: 'Message not found.' })
    if (String(message.sender) !== 'admin') return res.status(403).json({ message: 'You can only delete your own messages.' })
    await finalizeMessageDeletion(message)
    return res.status(204).end()
  } catch (error) {
    console.error('Message deletion failed:', error)
    return sendDatabaseError(res, error, 'Unable to delete this message.')
  }
})
app.delete('/api/messages/customer/:id', requireCustomer, async (req, res) => {
  const messageId = String(req.params.id || '').trim()
  if (!messageId) return res.status(400).json({ message: 'Message id is required.' })
  try {
    if (mongoConnected) {
      const message = await Message.findById(messageId).lean()
      if (!message) return res.status(404).json({ message: 'Message not found.' })
      if (String(message.customerId) !== String(req.customer._id) || String(message.sender) !== 'customer') return res.status(403).json({ message: 'You can only delete your own messages.' })
      await finalizeMessageDeletion(message)
      return res.status(204).end()
    }
    const message = conversationMessages.find((item) => String(item._id) === String(messageId))
    if (!message) return res.status(404).json({ message: 'Message not found.' })
    if (String(message.customerId) !== String(req.customer._id) || String(message.sender) !== 'customer') return res.status(403).json({ message: 'You can only delete your own messages.' })
    await finalizeMessageDeletion(message)
    return res.status(204).end()
  } catch (error) {
    console.error('Customer message deletion failed:', error)
    return sendDatabaseError(res, error, 'Unable to delete this message.')
  }
})
app.post('/api/messages', requireAdmin, (req, res) => messageMediaUpload.array('files', 10)(req, res, async (error) => {
  const customerId = String(req.body.customerId || '').trim()
  const text = String(req.body.text || '').trim()
  if (!customerId) return res.status(400).json({ message: 'Choose a customer to message.' })
  if (!text && (!req.files || !req.files.length)) return res.status(400).json({ message: 'Add a message or attachment before sending.' })
  if (error) {
    const detail = error.code === 'LIMIT_FILE_SIZE' ? 'Attachment must be 25 MB or smaller.' : 'Only images, PDF, docs, and audio files are supported.'
    return res.status(400).json({ message: detail })
  }
  try {
    let customerRecord = null
    if (mongoConnected) customerRecord = await Customer.findById(customerId).lean();
    else customerRecord = customers.find((customer) => String(customer._id) === String(customerId) && customer.status === 'Active')
    if (!customerRecord) return res.status(404).json({ message: 'Customer not found' })
    const attachments = (req.files || []).map((file) => ({
      fileName: file.originalname || file.filename,
      mimeType: file.mimetype,
      size: file.size,
      url: `/uploads/${file.filename}`,
      kind: file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('audio/') ? 'audio' : file.mimetype === 'application/pdf' ? 'pdf' : 'document'
    }))
    const payload = {
      customerId: String(customerId),
      customerName: customerRecord.customerName || '',
      sender: 'admin',
      text,
      attachments,
      status: 'sent',
      createdAt: new Date().toISOString()
    }
    if (mongoConnected) {
      const conversation = await Conversation.findOneAndUpdate({ customerId: String(customerId) }, {
        customerId: String(customerId),
        customerName: customerRecord.customerName,
        customerEmail: customerRecord.emailAddress,
        lastMessageAt: new Date(payload.createdAt),
        unreadCount: 0,
        lastReadByCustomerAt: new Date(payload.createdAt)
      }, { upsert: true, new: true, setDefaultsOnInsert: true })
      const created = await Message.create({ ...payload, customerName: conversation.customerName || customerRecord.customerName })
      await emitBadgeChange('message.changed', normalizeNotification('Message', created.toObject(), false))
      return res.status(201).json({ message: normalizeMessage(created.toObject()), customer: { ...customerRecord, _id: String(customerRecord._id) } })
    }
    const existingConversation = conversations.find((item) => String(item.customerId) === String(customerId))
    const createdMessage = { _id: `msg${Date.now()}`, ...payload }
    conversationMessages.push(createdMessage)
    if (existingConversation) {
      existingConversation.customerName = customerRecord.customerName
      existingConversation.customerEmail = customerRecord.emailAddress
      existingConversation.lastMessageAt = new Date(createdMessage.createdAt)
      existingConversation.unreadCount = 0
      existingConversation.lastReadByCustomerAt = new Date(createdMessage.createdAt)
    } else {
      conversations.push({
        customerId: String(customerId),
        customerName: customerRecord.customerName,
        customerEmail: customerRecord.emailAddress,
        lastMessageAt: new Date(createdMessage.createdAt),
        unreadCount: 0,
        lastReadByAdminAt: null,
        lastReadByCustomerAt: new Date(createdMessage.createdAt)
      })
    }
    await emitBadgeChange('message.changed', normalizeNotification('Message', createdMessage, false))
    return res.status(201).json({ message: normalizeMessage(createdMessage), customer: customerRecord })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to send message')
  }
}))
app.post('/api/messages/customer', requireCustomer, (req, res) => messageMediaUpload.array('files', 10)(req, res, async (error) => {
  const text = String(req.body.text || '').trim()
  let productContext = null
  if (req.body.productContext) {
    try {
      productContext = JSON.parse(req.body.productContext)
    } catch {
      return res.status(400).json({ message: 'Product context is invalid.' })
    }
  }
  if (!text && !productContext && (!req.files || !req.files.length)) return res.status(400).json({ message: 'Add a message or attachment before sending.' })
  if (error) return res.status(400).json({ message: 'Only images, PDF, docs, and audio files are supported.' })
  try {
    const customerId = String(req.customer._id)
    const customerName = req.customer.customerName || 'Customer'
    const attachments = (req.files || []).map((file) => ({
      fileName: file.originalname || file.filename,
      mimeType: file.mimetype,
      size: file.size,
      url: `/uploads/${file.filename}`,
      kind: file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('audio/') ? 'audio' : file.mimetype === 'application/pdf' ? 'pdf' : 'document'
    }))
    if (productContext?.productId && productContext?.selectedMoq) {
      attachments.push({
        fileName: productContext.title || 'Product',
        mimeType: 'application/json',
        size: 0,
        url: '',
        kind: 'product',
        productId: String(productContext.productId),
        productTitle: String(productContext.title || 'Product'),
        productImage: String(productContext.image || ''),
        productMoq: String(productContext.selectedMoq)
      })
    }
    const payload = { customerId, customerName, sender: 'customer', text, attachments, status: 'sent', createdAt: new Date().toISOString() }
    if (mongoConnected) {
      const existingConversation = await Conversation.findOne({ customerId }).lean()
      const nextUnreadCount = existingConversation && existingConversation.lastReadByAdminAt && new Date(payload.createdAt).getTime() <= new Date(existingConversation.lastReadByAdminAt).getTime() ? 0 : (existingConversation?.unreadCount || 0) + 1
      const conversation = await Conversation.findOneAndUpdate({ customerId }, {
        customerId,
        customerName,
        customerEmail: req.customer.emailAddress || '',
        lastMessageAt: new Date(payload.createdAt),
        unreadCount: nextUnreadCount,
        lastReadByAdminAt: existingConversation?.lastReadByAdminAt || null
      }, { upsert: true, new: true, setDefaultsOnInsert: true })
      const created = await Message.create({ ...payload, customerName: conversation.customerName || customerName })
      await emitBadgeChange('message.changed', normalizeNotification('Message', created.toObject(), true))
      return res.status(201).json({ message: normalizeMessage(created.toObject()) })
    }
    const existingConversation = conversations.find((item) => String(item.customerId) === String(customerId))
    const createdMessage = { _id: `msg${Date.now()}`, ...payload }
    conversationMessages.push(createdMessage)
    const nextUnreadCount = existingConversation && existingConversation.lastReadByAdminAt && new Date(createdMessage.createdAt).getTime() <= new Date(existingConversation.lastReadByAdminAt).getTime() ? 0 : (existingConversation?.unreadCount || 0) + 1
    if (existingConversation) {
      existingConversation.customerName = customerName
      existingConversation.lastMessageAt = new Date(createdMessage.createdAt)
      existingConversation.unreadCount = nextUnreadCount
    } else {
      conversations.push({ customerId, customerName, customerEmail: req.customer.emailAddress || '', lastMessageAt: new Date(createdMessage.createdAt), unreadCount: 1, lastReadByAdminAt: null, lastReadByCustomerAt: null })
    }
    await emitBadgeChange('message.changed', normalizeNotification('Message', createdMessage, true))
    return res.status(201).json({ message: normalizeMessage(createdMessage) })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to send customer message')
  }
}))
app.get('/api/inquiries', requireAdmin, async (req, res) => {
  if (databaseState()) {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1); const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const [data, total] = await readWithRetry('inquiries', () => Promise.all([Inquiry.find().sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Inquiry.countDocuments()]))
      return res.json({ data, page, limit, total, pages: Math.ceil(total / limit) })
    } catch (error) {
      return sendDatabaseError(res, error, 'Unable to load inquiries')
    }
  }
  if (process.env.MONGODB_URI) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to load inquiries')
  return res.json(pageResult(inquiries, req))
})
app.get('/api/contact-requests', requireAdmin, async (req, res) => {
  if (databaseState()) {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1); const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const [records, total] = await readWithRetry('contact-requests', () => Promise.all([ContactRequest.find().select('+idempotencyKey').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), ContactRequest.countDocuments()]))
      return res.json({ data: records.map(normalizeContactRequest), page, limit, total, pages: Math.ceil(total / limit) })
    } catch (error) {
      return sendDatabaseError(res, error, 'Unable to load contact requests')
    }
  }
  return sendDatabaseError(res, databaseUnavailableError(), 'Unable to load contact requests')
})
app.post('/api/contact-requests', async (req, res) => {
  const { firstName = '', phoneNumber = '', email = '', message = '' } = req.body
  if (![firstName, phoneNumber, email, message].every((value) => String(value).trim())) return res.status(400).json({ message: 'All contact fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  const idempotencyKey = String(req.body.idempotencyKey || '').trim()
  if (idempotencyKey && !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) return res.status(400).json({ message: 'Invalid request key' })
  if (!databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to save contact request')
  try {
    const result = await saveContactRequest({ firstName, phoneNumber, email, message, idempotencyKey })
    return res.status(result.created ? 201 : 200).json({ message: 'Contact request received', data: result.record })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to save contact request')
  }
})
app.put('/api/contact-requests/:id/respond', requireAdmin, async (req, res) => {
  if (!databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to update contact request')
  try {
    const contactRequest = await ContactRequest.findOneAndUpdate({ _id: req.params.id, status: 'New' }, { $set: { status: 'Responded' } }, { new: true }).select('+idempotencyKey').lean()
    if (!contactRequest) return res.status(404).json({ message: 'Contact request not found or already responded' })
    await emitBadgeChange('contact.changed')
    return res.json(normalizeContactRequest(contactRequest))
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to update contact request')
  }
})
app.post('/api/inquiries', async (req, res) => {
  const { firstName = '', phoneNumber = '', email = '', message = '', productId = '', product = '', productImage = '', quantity = '' } = req.body
  if (![firstName, phoneNumber, email, message].every((value) => String(value).trim())) return res.status(400).json({ message: 'All contact fields are required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' })
  if (!/^\+?[\d\s().-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ message: 'Enter a valid phone number' })
  if (process.env.MONGODB_URI && !databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to save inquiry')
  try {
    let productRecord = null
    if (productId) {
      if (mongoConnected && mongoose.isValidObjectId(productId)) {
        productRecord = await Product.findById(productId).select('title name image images description shortDescription').lean()
      } else {
        productRecord = products.find((item) => String(item._id) === String(productId)) || null
      }
    }
    const inquiryData = {
      buyer: firstName.trim(),
      phoneNumber: phoneNumber.trim(),
      email: email.trim(),
      productId: String(productId || ''),
      product: productRecord?.title || productRecord?.name || String(product || ''),
      productImage: productRecord?.image || productRecord?.images?.[0] || productImage || '',
      quantity: String(quantity || ''),
      message: message.trim(),
      status: 'New',
      submittedAt: new Date(),
      responses: []
    }
    let createdInquiry
    if (databaseState()) {
      createdInquiry = await Inquiry.create(inquiryData)
    } else if (process.env.MONGODB_URI) {
      return sendDatabaseError(res, databaseUnavailableError(), 'Unable to save inquiry')
    } else {
      createdInquiry = { _id: `i${Date.now()}`, ...inquiryData, submittedAt: inquiryData.submittedAt.toISOString() }
      inquiries.unshift(createdInquiry)
    }

    const inquiryForEmail = {
      ...createdInquiry.toObject ? createdInquiry.toObject() : createdInquiry,
      buyer: inquiryData.buyer,
      email: inquiryData.email,
      product: inquiryData.product,
      productImage: inquiryData.productImage,
      quantity: inquiryData.quantity,
      message: inquiryData.message,
      productDescription: productRecord?.description || productRecord?.shortDescription || String(product || '')
    }
    triggerInquiryConfirmationEmail(inquiryForEmail)
    await emitBadgeChange('inquiry.changed', normalizeNotification('Inquiry', createdInquiry.toObject ? createdInquiry.toObject() : createdInquiry, true))
    return res.status(201).json({ message: 'Contact request received', data: createdInquiry.toObject ? createdInquiry.toObject() : createdInquiry })
  } catch (error) {
    return sendDatabaseError(res, error, 'Unable to save inquiry')
  }
})
app.put('/api/inquiries/:id/respond', requireAdmin, async (req, res) => {
  const action = String(req.body.action || 'message').trim().toLowerCase()
  if (action === 'message' && !String(req.body.message || '').trim()) return res.status(400).json({ message: 'Inquiry and response message are required' })
  if (action === 'not-interested' && !String(req.body.reason || '').trim()) return res.status(400).json({ message: 'A reason is required' })
  if (action === 'order-confirm' && (!String(req.body.finalMoq || '').trim() || !String(req.body.finalMessage || '').trim())) return res.status(400).json({ message: 'Final MOQ and message are required' })
  if (process.env.MONGODB_URI && !databaseState()) return sendDatabaseError(res, databaseUnavailableError(), 'Unable to respond to inquiry')
  if (databaseState()) {
    try {
      const current = await readWithRetry('inquiry-response-current', () => Inquiry.findById(req.params.id).lean())
      if (!current) return res.status(404).json({ message: 'Inquiry not found' })
      if (action !== 'message' && current.status !== 'New') return res.status(409).json({ message: 'This inquiry has already been answered' })
      const update = { $push: { responses: { message: action === 'not-interested' ? req.body.reason : action === 'order-confirm' ? req.body.finalMessage : req.body.message, createdAt: new Date() } }, $set: { status: action === 'not-interested' ? 'Not Interested' : action === 'order-confirm' ? 'Order Confirmed' : 'Responded' } }
      if (action === 'not-interested') update.$set.notInterestedReason = String(req.body.reason).trim()
      if (action === 'order-confirm') Object.assign(update.$set, { finalMoq: String(req.body.finalMoq).trim(), finalMessage: String(req.body.finalMessage).trim(), orderConfirmedAt: new Date() })
      const inquiry = await Inquiry.findOneAndUpdate({ _id: req.params.id, ...(action !== 'message' ? { status: 'New' } : {}) }, update, { new: true }).lean()
      if (!inquiry) return res.status(404).json({ message: 'Inquiry not found' })
      await emitBadgeChange('inquiry.changed')
      if (action === 'order-confirm') await sendOrderConfirmationEmailSafely(inquiry)
      return res.json(inquiry)
    } catch (error) {
      return sendDatabaseError(res, error, 'Unable to respond to inquiry')
    }
  }
  const inquiry = inquiries.find((item) => item._id === req.params.id); if (!inquiry) return res.status(404).json({ message: 'Inquiry not found' }); if (action !== 'message' && inquiry.status !== 'New') return res.status(409).json({ message: 'This inquiry has already been answered' }); const responseMessage = action === 'not-interested' ? String(req.body.reason).trim() : action === 'order-confirm' ? String(req.body.finalMessage).trim() : String(req.body.message).trim(); inquiry.responses.push({ message: responseMessage, createdAt: new Date().toISOString() }); inquiry.status = action === 'not-interested' ? 'Not Interested' : action === 'order-confirm' ? 'Order Confirmed' : 'Responded'; if (action === 'not-interested') inquiry.notInterestedReason = String(req.body.reason).trim(); if (action === 'order-confirm') { inquiry.finalMoq = String(req.body.finalMoq).trim(); inquiry.finalMessage = String(req.body.finalMessage).trim(); inquiry.orderConfirmedAt = new Date().toISOString(); await sendOrderConfirmationEmailSafely(inquiry) } await emitBadgeChange('inquiry.changed'); return res.json(inquiry)
})

const start = () => {
  const initialize = async () => {
    if (redis) await redis.connect().catch((error) => console.error('Redis unavailable; using local cache:', error.message))
    if (process.env.MONGODB_URI) await connectMongo().catch(() => { })
    else logDatabaseState('disabled')
  }
  void initialize().finally(() => {
    httpServer.listen(port, () => console.log(`Omni RA Labs API listening on port ${port}`))
    const runMessageCleanup = () => cleanupExpiredMessages().catch((error) => console.error('Message cleanup failed:', error.message))
    void runMessageCleanup()
    setInterval(runMessageCleanup, MESSAGE_CLEANUP_INTERVAL_MS)
  })
}

export { app, Category, Product, Customer, CustomerSession, CustomerPasswordReset, CustomerSignupVerification, Employee, cleanupExpiredMessages, getExpiredMessageCutoff, databaseState, connectMongo, readWithRetry, start }

if (process.env.NODE_ENV !== 'test') start()
