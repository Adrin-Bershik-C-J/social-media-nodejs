const User = require("../models/User");
const Post = require("../models/Post");
const cloudinary = require("cloudinary").v2;
const { pushNotification } = require("../utils/notify");
const { io } = require("../utils/socket");

exports.getProfile = async (req, res) => {
  const user = req.user;
  res.json(user);
};

exports.updateProfile = async (req, res) => {
  const { name, bio } = req.body;
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { name, bio },
      { new: true }
    ).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.toggleFollow = async (req, res) => {
  const targetUserId = req.params.id;
  const currentUserId = req.user._id;

  if (String(currentUserId) === targetUserId) {
    return res.status(400).json({ message: "You can't follow yourself" });
  }

  try {
    /* 1. Check if target user exists and get current follow status */
    const [targetUser, currentUser] = await Promise.all([
      User.findById(targetUserId).select("followers"),
      User.findById(currentUserId).select("following"),
    ]);

    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const isFollowing = currentUser.following.includes(targetUserId);

    /* 2. Update follow relationships */
    if (isFollowing) {
      currentUser.following.pull(targetUserId);
      targetUser.followers.pull(currentUserId);
    } else {
      currentUser.following.push(targetUserId);
      targetUser.followers.push(currentUserId);
    }

    await Promise.all([currentUser.save(), targetUser.save()]);

    /* 3. Send response */
    res.json({
      message: isFollowing ? "User unfollowed" : "User followed",
      isFollowing: !isFollowing,
      followersCount: targetUser.followers.length,
      followingCount: currentUser.following.length,
    });

    /* 4. Send notification only when newly followed */
    if (!isFollowing) {
      setImmediate(async () => {
        try {
          await pushNotification({
            recipient: targetUserId,
            sender: currentUserId,
            type: "follow",
          });
        } catch (err) {
          console.error("Failed to send follow notification:", err);
        }
      });
    }
  } catch (err) {
    console.error("toggleFollow error:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};

exports.getFollowing = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate(
      "following",
      "name username profilePicture"
    );
    res.json(user.following);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch following users" });
  }
};

exports.getFollowers = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate(
      "followers",
      "name username profilePicture"
    );
    res.json(user.followers);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch followers" });
  }
};

exports.uploadProfilePicture = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded." });
    }

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "profile_pictures",
        resource_type: "image",
      },
      async (error, result) => {
        if (error) {
          console.error("Cloudinary error:", error);
          return res.status(500).json({ message: "Upload failed." });
        }

        const updatedUser = await User.findByIdAndUpdate(
          req.user._id,
          { profilePicture: result.secure_url },
          { new: true }
        ).select("-password"); // exclude password

        res.status(200).json(updatedUser);
      }
    );

    stream.end(req.file.buffer);
  } catch (err) {
    console.error("Profile picture upload error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getHomeFollowers = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("-password") // omit sensitive info
      .populate("following", "_id") // only get _id from followed users
      .populate("followers", "_id");

    res.json(user);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getUserDetails = async (req, res) => {
  try {
    const { username } = req.params;
    const currentUserId = req.user?._id;

    const user = await User.findOne({ username }).select(
      "name username bio profilePicture followers following"
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    const posts = await Post.find({ user: user._id })
      .populate("user", "name username profilePicture")
      .sort({ createdAt: -1 });

    const enrichedPosts = posts.map((post) => ({
      ...post.toObject(),
      likeCount: post.likes.length,
      isLiked: currentUserId ? post.likes.includes(currentUserId) : false,
    }));

    // Send whether logged-in user is following this profile
    const isFollowing = currentUserId
      ? user.followers.map(String).includes(currentUserId.toString())
      : false;

    res.status(200).json({
      user,
      posts: enrichedPosts,
      isFollowing,
    });
  } catch (err) {
    console.error("Error fetching user details:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
};
