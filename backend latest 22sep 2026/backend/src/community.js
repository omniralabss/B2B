import fs from 'node:fs'
import path from 'node:path'

const cursorEncode = (record) => Buffer.from(`${new Date(record.createdAt).toISOString()}|${record._id}`).toString('base64url')
const cursorDecode = (value, mongoose) => {
  if (!value) return null
  try {
    const [createdAt, id] = Buffer.from(value, 'base64url').toString().split('|')
    const date = new Date(createdAt)
    if (!mongoose.isValidObjectId(id) || Number.isNaN(date.getTime())) return false
    return { createdAt: date, _id: id }
  } catch {
    return false
  }
}
const removeFiles = async (files, uploadDirectory) => Promise.all((files || []).map((file) => fs.promises.unlink(path.join(uploadDirectory, file.filename)).catch(() => { })))

export function createCommunityRouter({ express, mongoose, multer, uploadDirectory, readWithRetry, databaseState, sendDatabaseError, requireCustomer, findCustomerSessionRecord }) {
  const router = express.Router()
  const Post = mongoose.models.CommunityPost || mongoose.model('CommunityPost', new mongoose.Schema({
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Customer' },
    text: { type: String, default: '', maxlength: 5000 },
    media: [{ _id: false, url: { type: String, required: true }, mimeType: { type: String, required: true }, kind: { type: String, enum: ['image', 'video'], required: true }, fileName: { type: String, required: true }, size: { type: Number, required: true } }],
    commentCount: { type: Number, default: 0 }
  }, { timestamps: true, collection: 'community_posts' }))
  const Reaction = mongoose.models.CommunityReaction || mongoose.model('CommunityReaction', new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'CommunityPost' },
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Customer' },
    reaction: { type: String, enum: ['like', 'dislike'], required: true }
  }, { timestamps: true, collection: 'community_reactions' }))
  const Comment = mongoose.models.CommunityComment || mongoose.model('CommunityComment', new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'CommunityPost' },
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Customer' },
    text: { type: String, required: true, trim: true, maxlength: 2000 }
  }, { timestamps: true, collection: 'community_comments' }))
  Post.schema.index({ createdAt: -1, _id: -1 })
  Reaction.schema.index({ postId: 1, customerId: 1 }, { unique: true })
  Reaction.schema.index({ postId: 1, reaction: 1 })
  Comment.schema.index({ postId: 1, createdAt: -1, _id: -1 })

  const mediaUpload = multer({
    storage: multer.diskStorage({
      destination: uploadDirectory,
      filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 4 },
    fileFilter: (_req, file, callback) => {
      if (/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)) return callback(null, true)
      return callback(new Error('Use JPEG, PNG, WebP, GIF, MP4, WebM, or MOV media'))
    }
  })
  const requireDatabase = (_req, res, next) => databaseState() ? next() : res.status(503).set('Retry-After', '1').json({ message: 'Community is temporarily unavailable', retryable: true })
  const requireMineCustomer = (req, res, next) => req.query.mine === 'true' ? requireCustomer(req, res, next) : next()
  const getCounts = async (postIds) => {
    if (!postIds.length) return new Map()
    const groups = await readWithRetry('community-reaction-counts', () => Reaction.aggregate([
      { $match: { postId: { $in: postIds } } },
      { $group: { _id: { postId: '$postId', reaction: '$reaction' }, count: { $sum: 1 } } }
    ]))
    const counts = new Map(postIds.map((id) => [String(id), { likeCount: 0, dislikeCount: 0 }]))
    for (const group of groups) {
      const count = counts.get(String(group._id.postId))
      if (count) count[group._id.reaction === 'like' ? 'likeCount' : 'dislikeCount'] = group.count
    }
    return counts
  }
  const serializePosts = async (posts, customerId = null) => {
    if (!posts.length) return []
    const ids = posts.map((post) => post._id)
    const [counts, ownReactions] = await Promise.all([
      getCounts(ids),
      customerId ? readWithRetry('community-own-reactions', () => Reaction.find({ postId: { $in: ids }, customerId }).select('postId reaction').lean()) : []
    ])
    const own = new Map(ownReactions.map((item) => [String(item.postId), item.reaction]))
    return posts.map((post) => ({
      _id: post._id,
      text: post.text,
      media: post.media,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      commentCount: post.commentCount || 0,
      author: { _id: post.authorId?._id, customerName: post.authorId?.customerName || 'Marketplace member' },
      ...counts.get(String(post._id)),
      myReaction: own.get(String(post._id)) || null
    }))
  }
  const optionalCustomer = async (req) => {
    try { return await findCustomerSessionRecord(req) } catch { return null }
  }
  const handleError = (res, error, message) => sendDatabaseError(res, error, message)

  router.get('/session', async (req, res) => res.json({ customer: await optionalCustomer(req) }))

  router.get('/posts', requireDatabase, requireMineCustomer, async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const cursor = cursorDecode(String(req.query.cursor || ''), mongoose)
    if (cursor === false) return res.status(400).json({ message: 'Invalid feed cursor' })
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 30)
    try {
      const customer = req.customer || await optionalCustomer(req)
      const filter = {
        ...(req.query.mine === 'true' ? { authorId: req.customer._id } : {}),
        ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {})
      }
      const records = await readWithRetry('community-feed', () => Post.find(filter).select('-__v').populate('authorId', 'customerName').sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean())
      const hasMore = records.length > limit
      const page = records.slice(0, limit)
      const posts = await serializePosts(page, customer?._id || null)
      return res.json({ posts, hasMore, nextCursor: hasMore && page.length ? cursorEncode(page[page.length - 1]) : null })
    } catch (error) { return handleError(res, error, 'Unable to load community posts') }
  })

  router.post('/posts', requireCustomer, (req, res) => mediaUpload.array('media', 4)(req, res, async (uploadError) => {
    const files = req.files || []
    if (uploadError) {
      await removeFiles(files, uploadDirectory)
      return res.status(uploadError.code === 'LIMIT_FILE_SIZE' ? 400 : uploadError.code === 'LIMIT_UNEXPECTED_FILE' ? 400 : 415).json({ message: uploadError.code === 'LIMIT_FILE_SIZE' ? 'Each media file must be 25 MB or smaller' : uploadError.code === 'LIMIT_UNEXPECTED_FILE' ? 'Choose up to four media files' : uploadError.message })
    }
    const text = String(req.body.text || '').trim()
    const videos = files.filter((file) => file.mimetype.startsWith('video/'))
    if (text.length > 5000 || (!text && !files.length) || videos.length > 1 || (videos.length && files.length > 1)) {
      await removeFiles(files, uploadDirectory)
      return res.status(400).json({ message: text.length > 5000 ? 'Posts must be 5,000 characters or fewer' : 'Add text, images, or one video to your post' })
    }
    try {
      const media = files.map((file) => ({ url: `/uploads/${file.filename}`, mimeType: file.mimetype, kind: file.mimetype.startsWith('video/') ? 'video' : 'image', fileName: file.originalname, size: file.size }))
      const post = await readWithRetry('community-create-post', () => Post.create({ authorId: req.customer._id, text, media }))
      const populated = await Post.findById(post._id).populate('authorId', 'customerName').lean()
      return res.status(201).json({ post: (await serializePosts([populated], req.customer._id))[0] })
    } catch (error) {
      await removeFiles(files, uploadDirectory)
      return handleError(res, error, 'Unable to create community post')
    }
  }))

  router.get('/posts/:postId', requireDatabase, async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    if (!mongoose.isValidObjectId(req.params.postId)) return res.status(400).json({ message: 'Invalid post id' })
    try {
      const customer = await optionalCustomer(req)
      const post = await readWithRetry('community-post-detail', () => Post.findById(req.params.postId).populate('authorId', 'customerName').lean())
      if (!post) return res.status(404).json({ message: 'Post not found' })
      return res.json({ post: (await serializePosts([post], customer?._id || null))[0] })
    } catch (error) { return handleError(res, error, 'Unable to load community post') }
  })

  router.post('/posts/:postId/reaction', requireCustomer, requireDatabase, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.postId)) return res.status(400).json({ message: 'Invalid post id' })
    const reaction = ['like', 'dislike'].includes(req.body.reaction) ? req.body.reaction : null
    if (!reaction) return res.status(400).json({ message: 'Choose like or dislike' })
    try {
      const exists = await readWithRetry('community-reaction-post', () => Post.exists({ _id: req.params.postId }))
      if (!exists) return res.status(404).json({ message: 'Post not found' })
      let updated = false
      for (let attempt = 0; attempt < 5 && !updated; attempt += 1) {
        const current = await Reaction.findOne({ postId: req.params.postId, customerId: req.customer._id }).lean()
        if (current?.reaction === reaction) {
          const result = await Reaction.deleteOne({ _id: current._id, reaction })
          updated = Boolean(result.deletedCount)
        } else if (current) {
          const result = await Reaction.updateOne({ _id: current._id, reaction: current.reaction }, { $set: { reaction } })
          updated = Boolean(result.modifiedCount)
        } else {
          try {
            await Reaction.create({ postId: req.params.postId, customerId: req.customer._id, reaction })
            updated = true
          } catch (error) { if (error.code !== 11000) throw error }
        }
      }
      if (!updated) return res.status(409).json({ message: 'Reaction changed concurrently. Please try again.' })
      const counts = (await getCounts([req.params.postId])).get(String(req.params.postId))
      const current = await Reaction.findOne({ postId: req.params.postId, customerId: req.customer._id }).select('reaction').lean()
      return res.json({ ...counts, myReaction: current?.reaction || null })
    } catch (error) { return handleError(res, error, 'Unable to update reaction') }
  })

  router.get('/posts/:postId/comments', requireDatabase, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.postId)) return res.status(400).json({ message: 'Invalid post id' })
    const cursor = cursorDecode(String(req.query.cursor || ''), mongoose)
    if (cursor === false) return res.status(400).json({ message: 'Invalid comments cursor' })
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50)
    try {
      const exists = await readWithRetry('community-comments-post', () => Post.exists({ _id: req.params.postId }))
      if (!exists) return res.status(404).json({ message: 'Post not found' })
      const filter = { postId: req.params.postId, ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {}) }
      const records = await readWithRetry('community-comments', () => Comment.find(filter).populate('authorId', 'customerName').sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean())
      const hasMore = records.length > limit
      const comments = records.slice(0, limit).map((comment) => ({ _id: comment._id, text: comment.text, createdAt: comment.createdAt, author: { _id: comment.authorId?._id, customerName: comment.authorId?.customerName || 'Marketplace member' } }))
      return res.json({ comments, hasMore, nextCursor: hasMore && comments.length ? cursorEncode(records[limit - 1]) : null })
    } catch (error) { return handleError(res, error, 'Unable to load comments') }
  })

  router.post('/posts/:postId/comments', requireCustomer, requireDatabase, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.postId)) return res.status(400).json({ message: 'Invalid post id' })
    const text = String(req.body.text || '').trim()
    if (!text || text.length > 2000) return res.status(400).json({ message: 'Comments must contain 1 to 2,000 characters' })
    try {
      const comment = await readWithRetry('community-create-comment', async () => {
        const post = await Post.findById(req.params.postId).select('_id').lean()
        if (!post) return null
        const created = await Comment.create({ postId: post._id, authorId: req.customer._id, text })
        await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } })
        return created
      })
      if (!comment) return res.status(404).json({ message: 'Post not found' })
      return res.status(201).json({ comment: { _id: comment._id, text: comment.text, createdAt: comment.createdAt, author: { _id: req.customer._id, customerName: req.customer.customerName } } })
    } catch (error) { return handleError(res, error, 'Unable to add comment') }
  })

  return router
}
