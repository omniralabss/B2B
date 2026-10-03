import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Image, MessageCircle, Send, ThumbsDown, ThumbsUp, Video, X } from "lucide-react";
import "./community.css";

const PAGE_SIZE = 12;
const relativeTime = (value) => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Just now";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let amount = seconds;
  for (const [limit, unit] of units) {
    if (Math.abs(amount) < limit) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
    amount = Math.round(amount / limit);
  }
  return "Just now";
};
const navigateCommunity = (path) => {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "smooth" });
};
const requireSignIn = () => window.dispatchEvent(new CustomEvent("marketplace-auth-required"));

function CommunityPostCard({ post, mediaUrl, onOpen, onReaction, reactionBusy, detail = false }) {
  return (
    <article className={`community-post${detail ? " community-post-detail" : ""}`}>
      <header className="community-post-header">
        <span className="community-avatar" aria-hidden="true">{(post.author?.customerName || "M").trim().slice(0, 1).toUpperCase()}</span>
        <div className="community-author">
          <strong>{post.author?.customerName || "Marketplace member"}</strong>
          <time dateTime={post.createdAt}>{relativeTime(post.createdAt)}</time>
        </div>
      </header>
      {post.text && <p className="community-post-text">{post.text}</p>}
      {post.media?.length > 0 && (
        <div className={`community-media${post.media.length > 1 ? " community-media-grid" : ""}`}>
          {post.media.map((media) => (
            media.kind === "video" ? (
              <video key={media.url} src={mediaUrl(media.url)} controls preload="metadata" playsInline aria-label="Community post video" />
            ) : (
              <img key={media.url} src={mediaUrl(media.url)} alt="Community post" loading="lazy" />
            )
          ))}
        </div>
      )}
      <div className="community-engagement-summary">
        <span>{post.likeCount || 0} likes</span>
        <button type="button" onClick={onOpen}>{post.commentCount || 0} comments</button>
      </div>
      <div className="community-post-actions">
        <button type="button" className={post.myReaction === "like" ? "selected" : ""} onClick={() => onReaction(post._id, "like")} disabled={reactionBusy} aria-pressed={post.myReaction === "like"}>
          <ThumbsUp size={16} /> Like <span>{post.likeCount || 0}</span>
        </button>
        <button type="button" className={post.myReaction === "dislike" ? "selected" : ""} onClick={() => onReaction(post._id, "dislike")} disabled={reactionBusy} aria-pressed={post.myReaction === "dislike"}>
          <ThumbsDown size={16} /> Dislike <span>{post.dislikeCount || 0}</span>
        </button>
        <button type="button" onClick={onOpen}>
          <MessageCircle size={16} /> {detail ? "Discussion" : "Comment"}
        </button>
      </div>
    </article>
  );
}

export default function CommunityPage({ apiUrl, mediaUrl, fetchWithRecovery, parseResponse, postId = "" }) {
  const [customer, setCustomer] = useState(null);
  const [posts, setPosts] = useState([]);
  const [feedFilter, setFeedFilter] = useState("all");
  const [selectedPost, setSelectedPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [commentsCursor, setCommentsCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [commentsError, setCommentsError] = useState("");
  const [reactionBusy, setReactionBusy] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [pendingCompose, setPendingCompose] = useState(false);
  const [postText, setPostText] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]);
  const [mediaPreviews, setMediaPreviews] = useState([]);
  const [composeError, setComposeError] = useState("");
  const [posting, setPosting] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentPosting, setCommentPosting] = useState(false);
  const [commentError, setCommentError] = useState("");
  const feedSentinel = useRef(null);
  const feedInFlight = useRef(false);
  const feedGeneration = useRef(0);
  const pendingComposeRef = useRef(false);

  const request = async (path, options = {}) => parseResponse(await fetchWithRecovery(`${apiUrl}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...options,
  }));
  const updatePost = (postIdToUpdate, update) => {
    setPosts((current) => current.map((post) => post._id === postIdToUpdate ? { ...post, ...update } : post));
    setSelectedPost((current) => current?._id === postIdToUpdate ? { ...current, ...update } : current);
  };

  useEffect(() => {
    let active = true;
    request("/community/session")
      .then((result) => { if (active) setCustomer(result?.customer || null); })
      .catch(() => { if (active) setCustomer(null); });
    const handleAuthChange = (event) => {
      const nextCustomer = event.detail || null;
      setCustomer(nextCustomer);
      if (!nextCustomer) setFeedFilter((current) => current === "mine" ? "all" : current);
      if (nextCustomer && pendingComposeRef.current) {
        pendingComposeRef.current = false;
        setPendingCompose(false);
        setComposeOpen(true);
      }
    };
    const handleAuthCancel = () => {
      pendingComposeRef.current = false;
      setPendingCompose(false);
    };
    window.addEventListener("marketplace-customer-auth-changed", handleAuthChange);
    window.addEventListener("marketplace-auth-cancelled", handleAuthCancel);
    return () => {
      active = false;
      window.removeEventListener("marketplace-customer-auth-changed", handleAuthChange);
      window.removeEventListener("marketplace-auth-cancelled", handleAuthCancel);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = ++feedGeneration.current;
    feedInFlight.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setSelectedPost(null);
    setComments([]);
    if (postId) {
      Promise.all([
        request(`/community/posts/${encodeURIComponent(postId)}`),
        request(`/community/posts/${encodeURIComponent(postId)}/comments?limit=20`),
      ]).then(([postResult, commentResult]) => {
        if (!active) return;
        setError("");
        setSelectedPost(postResult.post);
        setComments(commentResult.comments || []);
        setCommentsCursor(commentResult.nextCursor || null);
        setCommentsHasMore(Boolean(commentResult.hasMore));
      }).catch((requestError) => {
        if (active) setError(requestError.message || "Unable to load this discussion.");
      }).finally(() => { if (active) setLoading(false); });
    } else {
      setPosts([]);
      setNextCursor(null);
      setHasMore(false);
      request(`/community/posts?limit=${PAGE_SIZE}${feedFilter === "mine" ? "&mine=true" : ""}`)
        .then((result) => {
          if (!active) return;
          setError("");
          setPosts(result.posts || []);
          setHasMore(Boolean(result.hasMore));
          setNextCursor(result.nextCursor || null);
        }).catch((requestError) => {
          if (active) setError(requestError.message || "Unable to load community posts.");
        }).finally(() => { if (active) setLoading(false); });
    }
    return () => {
      active = false;
      if (feedGeneration.current === generation) {
        feedGeneration.current += 1;
        feedInFlight.current = false;
      }
    };
  }, [postId, reloadKey, feedFilter]);

  useEffect(() => {
    const urls = mediaFiles.map((file) => URL.createObjectURL(file));
    setMediaPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [mediaFiles]);

  useEffect(() => {
    if (postId || !hasMore || loadingMore || !feedSentinel.current) return undefined;
    const generation = feedGeneration.current;
    const observer = new IntersectionObserver((entries) => {
      if (generation !== feedGeneration.current || !entries[0]?.isIntersecting || feedInFlight.current) return;
      feedInFlight.current = true;
      setLoadingMore(true);
      request(`/community/posts?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor || "")}${feedFilter === "mine" ? "&mine=true" : ""}`)
        .then((result) => {
          if (generation !== feedGeneration.current) return;
          setError("");
          setPosts((current) => [...current, ...(result.posts || [])]);
          setHasMore(Boolean(result.hasMore));
          setNextCursor(result.nextCursor || null);
        }).catch((requestError) => {
          if (generation !== feedGeneration.current) return;
          setError(requestError.message || "Unable to load more posts.");
          setHasMore(false);
        }).finally(() => {
          if (generation !== feedGeneration.current) return;
          feedInFlight.current = false;
          setLoadingMore(false);
        });
    }, { rootMargin: "240px" });
    observer.observe(feedSentinel.current);
    return () => observer.disconnect();
  }, [postId, hasMore, loadingMore, nextCursor, feedFilter]);

  const selectFeedFilter = (filter) => {
    if (filter === "mine" && !customer) return requireSignIn();
    if (filter !== feedFilter) setFeedFilter(filter);
  };
  const openPost = (id) => navigateCommunity(`/community/${encodeURIComponent(id)}`);
  const returnToFeed = () => navigateCommunity("/community");
  const handleReaction = async (id, reaction) => {
    if (!customer) return requireSignIn();
    if (reactionBusy) return;
    setReactionBusy(id);
    try {
      const result = await request(`/community/posts/${encodeURIComponent(id)}/reaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction }),
      });
      updatePost(id, result);
    } catch (requestError) {
      setError(requestError.message || "Unable to update your reaction.");
    } finally { setReactionBusy(""); }
  };
  const startCompose = () => {
    if (!customer) {
      pendingComposeRef.current = true;
      setPendingCompose(true);
      requireSignIn();
      return;
    }
    setComposeError("");
    setComposeOpen(true);
  };
  const closeCompose = () => {
    if (posting) return;
    setComposeOpen(false);
    setPendingCompose(false);
    pendingComposeRef.current = false;
    setPostText("");
    setMediaFiles([]);
    setComposeError("");
  };
  const selectMedia = (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (selected.length > 4) return setComposeError("Choose up to four images, or one video.");
    const videoFiles = selected.filter((file) => file.type.startsWith("video/"));
    if (videoFiles.length > 1 || (videoFiles.length && selected.length > 1)) return setComposeError("A post can include up to four images or one video.");
    if (selected.some((file) => file.size > 25 * 1024 * 1024)) return setComposeError("Each media file must be 25 MB or smaller.");
    setComposeError("");
    setMediaFiles(selected);
  };
  const submitPost = async (event) => {
    event.preventDefault();
    if (!postText.trim() && !mediaFiles.length) return setComposeError("Add text, images, or a video to your post.");
    if (postText.length > 5000) return setComposeError("Posts must be 5,000 characters or fewer.");
    setPosting(true);
    setComposeError("");
    const body = new FormData();
    body.append("text", postText);
    mediaFiles.forEach((file) => body.append("media", file));
    try {
      const result = await request("/community/posts", { method: "POST", body });
      setPosts((current) => [result.post, ...current.filter((post) => post._id !== result.post._id)]);
      setComposeOpen(false);
      setPostText("");
      setMediaFiles([]);
      setComposeError("");
      if (postId) returnToFeed();
    } catch (requestError) {
      setComposeError(requestError.message || "Unable to publish your post.");
    } finally { setPosting(false); }
  };
  const loadMoreComments = async () => {
    if (!commentsCursor || commentsLoading || !postId) return;
    setCommentsLoading(true);
    setCommentsError("");
    try {
      const result = await request(`/community/posts/${encodeURIComponent(postId)}/comments?limit=20&cursor=${encodeURIComponent(commentsCursor)}`);
      setComments((current) => [...current, ...(result.comments || [])]);
      setCommentsCursor(result.nextCursor || null);
      setCommentsHasMore(Boolean(result.hasMore));
    } catch (requestError) {
      setCommentsError(requestError.message || "Unable to load more comments.");
    } finally { setCommentsLoading(false); }
  };
  const submitComment = async (event) => {
    event.preventDefault();
    const text = commentText.trim();
    if (!text) return;
    if (!customer) return requireSignIn();
    setCommentPosting(true);
    setCommentError("");
    try {
      const result = await request(`/community/posts/${encodeURIComponent(postId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setComments((current) => [result.comment, ...current]);
      setCommentText("");
      setSelectedPost((current) => current ? { ...current, commentCount: (current.commentCount || 0) + 1 } : current);
      updatePost(postId, { commentCount: (selectedPost?.commentCount || 0) + 1 });
    } catch (requestError) {
      setCommentError(requestError.message || "Unable to add your comment.");
    } finally { setCommentPosting(false); }
  };

  return (
    <main className="community-page">
      <div className="community-shell">
        {!postId && (
          <div className="community-toolbar">
            <div className="community-feed-filter" role="group" aria-label="Filter community posts">
              <button type="button" className={feedFilter === "all" ? "selected" : ""} onClick={() => selectFeedFilter("all")} aria-pressed={feedFilter === "all"}>All Posts</button>
              <button type="button" className={feedFilter === "mine" ? "selected" : ""} onClick={() => selectFeedFilter("mine")} aria-pressed={feedFilter === "mine"}>My Posts</button>
            </div>
            <button type="button" className="button primary community-create-button" onClick={startCompose}><Send size={16} /> Create post</button>
          </div>
        )}
        {postId && <button type="button" className="community-back-button" onClick={returnToFeed}><ArrowLeft size={16} /> Back to Community</button>}

        {error && !loading && <div className="community-alert" role="alert">{error}<button type="button" onClick={() => setReloadKey((current) => current + 1)}>Try again</button></div>}
        {loading ? <div className="community-loading"><div className="loading-region"><span className="community-spinner" /></div></div> : postId ? (
          selectedPost ? (
            <div className="community-detail-column">
              <CommunityPostCard post={selectedPost} mediaUrl={mediaUrl} onOpen={() => { }} onReaction={handleReaction} reactionBusy={reactionBusy === selectedPost._id} detail />
              <section className="community-discussion" aria-labelledby="community-discussion-title">
                <div className="community-discussion-heading"><h2 id="community-discussion-title">Discussion</h2><span>{selectedPost.commentCount || 0} comments</span></div>
                <form className="community-comment-form" onSubmit={submitComment}>
                  <textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder={customer ? "Add to the discussion..." : "Sign in to add a comment"} maxLength={2000} rows={2} aria-label="Write a comment" />
                  <button type="submit" className="button primary" disabled={!commentText.trim() || commentPosting}><Send size={15} /> {commentPosting ? "Posting..." : "Comment"}</button>
                </form>
                {commentError && <p className="community-form-error" role="alert">{commentError}</p>}
                {commentsError && <p className="community-form-error" role="alert">{commentsError}</p>}
                {commentsLoading && !comments.length && <div className="community-comments-loading"><span className="community-spinner" /></div>}
                {!comments.length && !commentsLoading ? <p className="community-empty-comments">No comments yet. Start the discussion.</p> : (
                  <div className="community-comments">
                    {comments.map((comment) => (
                      <article className="community-comment" key={comment._id}>
                        <span className="community-avatar community-comment-avatar" aria-hidden="true">{(comment.author?.customerName || "M").trim().slice(0, 1).toUpperCase()}</span>
                        <div className="community-comment-body"><div className="community-comment-meta"><strong>{comment.author?.customerName || "Marketplace member"}</strong><time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time></div><p>{comment.text}</p></div>
                      </article>
                    ))}
                  </div>
                )}
                {commentsHasMore && <button type="button" className="community-load-comments" onClick={loadMoreComments} disabled={commentsLoading}>{commentsLoading ? "Loading comments..." : "Load earlier comments"}</button>}
              </section>
            </div>
          ) : <div className="community-empty"><MessageCircle size={24} /><strong>Post not found</strong><button type="button" onClick={returnToFeed}>Return to Community</button></div>
        ) : (
          <>
            <div className="community-feed">
              {posts.map((post) => <CommunityPostCard key={post._id} post={post} mediaUrl={mediaUrl} onOpen={() => openPost(post._id)} onReaction={handleReaction} reactionBusy={reactionBusy === post._id} />)}
              {!posts.length && !error && <div className="community-empty"><MessageCircle size={24} /><strong>{feedFilter === "mine" ? "You haven't posted yet." : "No posts yet"}</strong><span>Start a conversation with the marketplace community.</span>{customer && <button type="button" className="button primary" onClick={startCompose}>Create the first post</button>}</div>}
              {hasMore && <div className="community-feed-sentinel" ref={feedSentinel}>{loadingMore && <span className="community-spinner" aria-label="Loading more posts" />}</div>}
            </div>
          </>
        )}
      </div>

      {composeOpen && (
        <div className="community-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCompose(); }}>
          <section className="community-compose-modal" role="dialog" aria-modal="true" aria-labelledby="community-compose-title">
            <header><h2 id="community-compose-title">Create a post</h2><button type="button" className="community-icon-button" onClick={closeCompose} aria-label="Close create post"><X size={19} /></button></header>
            <form onSubmit={submitPost}>
              <div className="community-compose-author"><span className="community-avatar" aria-hidden="true">{(customer?.customerName || "M").trim().slice(0, 1).toUpperCase()}</span><strong>{customer?.customerName || "Marketplace member"}</strong></div>
              <textarea className="community-compose-text" value={postText} onChange={(event) => setPostText(event.target.value)} placeholder="Share something with the community..." maxLength={5000} rows={6} autoFocus aria-label="Post text" />
              {mediaPreviews.length > 0 && <div className="community-preview-grid">{mediaPreviews.map((url, index) => mediaFiles[index]?.type.startsWith("video/") ? <video key={url} src={url} controls playsInline /> : <img key={url} src={url} alt="Selected upload preview" />)}</div>}
              <div className="community-compose-tools"><label className="community-attach-button"><Image size={17} /> Add photos or video<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple onChange={selectMedia} /></label><span>{postText.length}/5000</span></div>
              {composeError && <p className="community-form-error" role="alert">{composeError}</p>}
              <footer><button type="button" className="button outline" onClick={closeCompose} disabled={posting}>Cancel</button><button type="submit" className="button primary" disabled={posting || (!postText.trim() && !mediaFiles.length)}>{posting ? "Publishing..." : "Publish post"}</button></footer>
            </form>
          </section>
        </div>
      )}
      {pendingCompose && !composeOpen && <span className="sr-only" role="status">Waiting for sign-in</span>}
    </main>
  );
}
