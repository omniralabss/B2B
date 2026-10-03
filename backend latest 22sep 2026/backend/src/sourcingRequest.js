export const sourcingEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const sourcingPhonePattern = /^\+?[\d\s().-]{7,20}$/

const fieldOrder = ['customerName', 'quantity', 'targetPrice', 'phoneNumber', 'email']
const quantityPattern = /(?:(?:need|want|require|order|quantity|qty|moq|for)\s+(?:about\s+)?|(?:actually|correction|change(?:d)? to|make it)[:,]?\s*)(\d[\d,.]*(?:\s*(?:units?|pieces?|pcs|sets?|pairs?|dozen|boxes|cartons))?)/i
const currencyCodes = 'USDT|USD|PKR|EUR|GBP|INR|AED|SAR|CNY|JPY|CAD|AUD|TRY|CHF|RUB|BDT|LKR|NPR|MYR|SGD|NZD|ZAR'
const amountPattern = new RegExp(`(?:[$€£₹]\\s*)?\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:${currencyCodes}))?`, 'i')
const explicitPricePattern = new RegExp(`(?:budget|target price|price(?: per unit)?|spend)\\s*(?:is|of|around|about|:|=)?\\s*(${amountPattern.source})`, 'i')
const explicitPriceToken = new RegExp(`(?:[$€£₹]\\s*\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${currencyCodes}))`, 'i')
const numericPriceAnswer = /^(?:[$€£₹]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:each|per unit|\/unit))?$/i
const specificationSignal = /\b(?:waterproof|water-resistant|dustproof|shockproof|compatible(?: with)?|made of|material|colour|color|size|dimension|model|feature|specification|specs?|details?|with\s+(?:a|an|the)\s+\w+|for\s+(?:iphone|ipad|samsung|android|usb|type-c))\b/i

const clean = (value) => String(value || '').trim()
const isValidPhone = (value) => sourcingPhonePattern.test(clean(value))
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const parseTargetPrice = (message, askedForPrice = false) => {
  const text = clean(message)
  let value = text.match(explicitPricePattern)?.[1] || text.match(explicitPriceToken)?.[0]
  if (!value && askedForPrice && numericPriceAnswer.test(text)) value = text.replace(/\s*(?:each|per unit|\/unit)$/i, '').trim()
  if (!value) return ''
  value = value.replace(/\s*(?:each|per unit|\/unit)$/i, '').trim().replace(/\s+/g, ' ')
  const hasCurrency = /[$€£₹]|\b(?:USDT|USD|PKR|EUR|GBP|INR|AED|SAR|CNY|JPY|CAD|AUD|TRY|CHF|RUB|BDT|LKR|NPR|MYR|SGD|NZD|ZAR)\b/i.test(value)
  return `${value}${hasCurrency ? '' : ' USDT'}`
}

const extractProductDetails = (message, fields, askedField) => {
  const text = clean(message)
  if (!text || !specificationSignal.test(text)) return ''
  let details = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/(?:my name is|i am|i'm)\s+/gi, ' ')
    .replace(/(?:budget|target price|price(?: per unit)?|spend)\s*(?:is|of|around|about|:|=)?\s*(?:[$€£₹]\s*)?\d[\d,.]*(?:\s*(?:USDT|USD|PKR|EUR|GBP|INR|AED|SAR|CNY|JPY|CAD|AUD|TRY|CHF|RUB|BDT|LKR|NPR|MYR|SGD|NZD|ZAR|each|per unit|\/unit))?/gi, ' ')
    .replace(/\b\d[\d,.]*\s*(?:units?|pieces?|pcs|sets?|pairs?|dozen|boxes|cartons)\b/gi, ' ')
  if (fields.product) {
    const productPattern = fields.product.trim().split(/\s+/).map((word) => escapeRegExp(word.replace(/s$/i, '')) + 's?').join('\\s+')
    details = details.replace(new RegExp(productPattern, 'gi'), ' ')
  }
  if (fields.customerName) details = details.replace(new RegExp(escapeRegExp(fields.customerName), 'gi'), ' ')
  if (fields.targetPrice) details = details.replace(new RegExp(escapeRegExp(fields.targetPrice), 'gi'), ' ')
  if (fields.quantity) details = details.replace(new RegExp(escapeRegExp(fields.quantity), 'gi'), ' ')
  if (askedField === 'customerName') details = details.replace(/^[^,;.!]+/, ' ')
  details = details
    .replace(/\b(?:i|we)\s+(?:need|want|would like|am looking for)\b/gi, ' ')
    .replace(/\b(?:my|the)\s+(?:name|budget|target price|price|quantity|moq)\s+(?:is|of)\b/gi, ' ')
    .replace(/\b(?:please|also|and|for|my|each|per unit)\b/gi, ' ')
    .replace(/[,:;.!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return specificationSignal.test(text) && details.length >= 4 ? details.slice(0, 300) : ''
}

export const sourcingQuestion = (field) => ({
  customerName: 'What is your name?',
  quantity: 'How many units do you need?',
  targetPrice: 'What target price per unit are you expecting? You can reply in USD or your preferred currency.',
  phoneNumber: 'What phone number should our vendors use to reach you?',
  email: 'What email address should we use for the sourcing request?'
}[field] || '')

export const nextSourcingField = (fields) => fieldOrder.find((field) => !clean(fields[field])) || null

export const formatSourcingContactMessage = ({ product, quantity, targetPrice, details = '' }) => [
  `Product: ${clean(product)}`,
  `MOQ: ${/\b(?:units?|pieces?|pcs|sets?|pairs?|dozen|boxes|cartons)\b/i.test(clean(quantity)) ? clean(quantity) : `${clean(quantity)} units`}`,
  `Target price: ${clean(targetPrice)} per unit`,
  ...(clean(details) ? [`Details: ${clean(details)}`] : [])
].join('\n').slice(0, 2000)

export const updateSourcingState = (state, message) => {
  const text = clean(message).slice(0, 1000)
  const fields = { ...state.fields }
  const askedField = state.askedField
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
  const phone = text.match(/\+?\d[\d\s().-]{5,}\d/)?.[0]?.trim()
  const quantity = text.match(quantityPattern)?.[1] || text.match(/\b(\d[\d,.]*\s*(?:units?|pieces?|pcs|sets?|pairs?|dozen|boxes|cartons))\b/i)?.[1]
  const named = text.match(/(?:my name is|i am|i'm)\s+([^,;]+)/i)?.[1]

  const name = named ? named.split(/\s+and\s+(?=(?:my|i\b|need\b|want\b|require\b|budget\b|target\b|quantity\b|qty\b|phone\b|email\b))/i)[0].trim() : askedField === 'customerName' ? text.split(/[,;\n]/)[0].trim() : ''
  if (name.length > 0 && name.length <= 160) fields.customerName = name
  const requestedQuantity = quantity?.trim() || (askedField === 'quantity' ? text.match(/^(\d[\d,.]*(?:\s*(?:units?|pieces?|pcs|sets?|pairs?|dozen|boxes|cartons))?)(?:\s+.*)?$/i)?.[1] || '' : '')
  if (requestedQuantity && requestedQuantity.length <= 80) fields.quantity = requestedQuantity
  const requestedPrice = parseTargetPrice(text, askedField === 'targetPrice')
  if (requestedPrice && requestedPrice.length <= 80) fields.targetPrice = requestedPrice
  if (phone && isValidPhone(phone)) fields.phoneNumber = phone
  else if (askedField === 'phoneNumber' && isValidPhone(text)) fields.phoneNumber = text
  if (email && email.length <= 254 && sourcingEmailPattern.test(email)) fields.email = email
  else if (askedField === 'email' && text.length <= 254 && sourcingEmailPattern.test(text)) fields.email = text

  return {
    ...state,
    fields,
    lastAnsweredField: askedField,
    askedField: nextSourcingField(fields),
    details: [...new Set([state.details || '', extractProductDetails(text, fields, askedField)].filter(Boolean))].join('; ').slice(0, 600)
  }
}

export const createSourcingState = ({ message, product, requestId }) => updateSourcingState({
  requestId,
  fields: { product: clean(product).slice(0, 160), customerName: '', quantity: '', targetPrice: '', phoneNumber: '', email: '' },
  askedField: null,
  details: ''
}, message)

export const hasRelevantActiveProduct = (products, query, scoreProduct) =>
  products.some((product) => scoreProduct(product, query) >= 180)