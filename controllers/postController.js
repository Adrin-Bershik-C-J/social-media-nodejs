const Post = require("../models/Post");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const User = require("../models/User");
const { pushBulkNotifications, pushNotification } = require("../utils/notify");
const { io } = require("../utils/socket");

exports.createPost = async (req, res) => {
  try {
    const { caption = "" } = req.body;
    const files = req.files || [];

    let imageUrls = [];
    let videoUrl = "";

    /* ────────────── 1. Upload to Cloudinary ────────────── */
    if (files.length) {
      const uploads = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const isVideo = file.mimetype.startsWith("video/");
              cloudinary.uploader
                .upload_stream(
                  {
                    resource_type: isVideo ? "video" : "image",
                    folder: "posts",
                  },
                  (err, result) => {
                    if (err) return reject(err);
                    resolve({
                      url: result.secure_url,
                      type: isVideo ? "video" : "image",
                    });
                  },
                )
                .end(file.buffer);
            }),
        ),
      );

      // classify + validate
      uploads.forEach(({ url, type }) =>
        type === "image" ? imageUrls.push(url) : (videoUrl = url),
      );

      if (imageUrls.length > 5)
        return res.status(400).json({ message: "Max 5 images allowed." });

      if (uploads.filter((u) => u.type === "video").length > 1)
        return res.status(400).json({ message: "Only one video allowed." });
    }

    /* ────────────── 2. Persist Post ────────────── */
    const post = await Post.create({
      user: req.user._id,
      caption,
      images: imageUrls,
      video: videoUrl,
    });

    await post.populate("user", "name username profilePicture");

    /* ────────────── 3. Send response ASAP ────────────── */
    res.status(201).json(post); // 👉 client unblocked

    /* ────────────── 4. Fire‑and‑forget follower notifications ────────────── */
    setImmediate(async () => {
      try {
        const { followers } = await User.findById(req.user._id)
          .select("followers")
          .lean();

        if (!followers?.length) return;

        // Create notifications for all followers
        const notifications = followers.map((fid) => ({
          recipient: fid,
          sender: req.user._id,
          type: "new_post",
          post: post._id,
        }));

        // Use bulk notification utility
        await pushBulkNotifications(notifications);
      } catch (err) {
        console.error("notify followers error:", err);
      }
    });
  } catch (err) {
    console.error("createPost error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Server error" });
    }
  }
};

exports.getAllPosts = async (req, res) => {
  try {
    // Pagination params
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = { user: req.user._id };

    // Count total posts for pagination
    const totalPosts = await Post.countDocuments(filter);
    const totalPages = Math.ceil(totalPosts / limit);
    const hasMore = page < totalPages;

    const posts = await Post.find(filter)
      .populate("user", "username name profilePicture")
      .populate("comments.user", "username name profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const enrichedPosts = posts.map((post) => ({
      ...post.toObject(),
      likeCount: post.likes.length,
      isLiked: post.likes.includes(req.user._id),
    }));

    res.json({
      posts: enrichedPosts,
      currentPage: page,
      totalPages,
      totalPosts,
      hasMore,
      postsPerPage: limit,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// controllers/postController.js & userController.js
exports.likePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const userId = req.user._id;
    const liked = !post.likes.includes(userId);

    liked ? post.likes.push(userId) : post.likes.pull(userId);
    await post.save();

    /* send response first */
    res.json({
      message: liked ? "Post liked" : "Like removed",
      likeCount: post.likes.length,
      isLiked: liked,
    });

    /* async notification - only when liking (not unliking) and not own post */
    if (liked && String(post.user) !== String(userId)) {
      setImmediate(async () => {
        try {
          await pushNotification({
            recipient: post.user,
            sender: userId,
            type: "like_post",
            post: post._id,
          });
        } catch (err) {
          console.error("Failed to send like notification:", err);
        }
      });
    }
  } catch (err) {
    console.error("likePost error:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};

// exports.commentPost = async (req, res) => {
//   const { text } = req.body;
//   try {
//     const post = await Post.findById(req.params.id);
//     post.comments.push({ user: req.user._id, text });
//     await post.save();
//     res.json({ message: "Comment added" });
//   } catch (err) {
//     res.status(500).json({ message: "Server error" });
//   }
// };

exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (post.user.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to delete this post" });
    }

    await post.deleteOne();
    res.json({ message: "Post deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getFeedPosts = async (req, res) => {
  try {
    const currentUser = req.user;

    // Pagination params
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Fetch all posts not created by the current user
    const filter = { user: { $ne: currentUser._id } };

    // Count total posts for pagination
    const totalPosts = await Post.countDocuments(filter);
    const totalPages = Math.ceil(totalPosts / limit);
    const hasMore = page < totalPages;

    const posts = await Post.find(filter)
      .populate("user", "username name profilePicture")
      .populate("comments.user", "username name profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Remove edge case where user info is null
    const filteredPosts = posts.filter((post) => post.user);

    // Add likeCount and isLiked info
    const enrichedPosts = filteredPosts.map((post) => ({
      ...post.toObject(),
      likeCount: post.likes.length,
      isLiked: post.likes.includes(currentUser._id),
    }));

    res.json({
      posts: enrichedPosts,
      currentPage: page,
      totalPages,
      totalPosts,
      hasMore,
      postsPerPage: limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// controllers/postController.js
exports.editPost = async (req, res) => {
  const { caption } = req.body;
  try {
    const post = await Post.findById(req.params.id);

    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.user.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to edit this post" });
    }

    post.caption = caption;
    await post.save();

    res.json(post);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getUserPostsByUsername = async (req, res) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: "User not found" });

    const posts = await Post.find({ user: user._id })
      .populate("user", "name username profilePicture")
      .sort({ createdAt: -1 });

    res.status(200).json({ posts });
  } catch (err) {
    console.error("Error fetching user posts:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.getSinglePost = async (req, res) => {
  const post = await Post.findById(req.params.id)
    .populate("user", "name username profilePicture")
    .lean();

  if (!post) return res.status(404).json({ message: "Post not found" });
  res.json(post);
};
