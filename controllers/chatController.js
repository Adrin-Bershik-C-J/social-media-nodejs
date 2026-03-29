const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { io } = require("../utils/socket");

/**
 * GET /api/chats
 * Returns all conversations for the logged-in user, sorted by most recent.
 * Each conversation includes the last message and unread count.
 */
exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
    })
      .sort({ updatedAt: -1 })
      .populate("participants", "username name profilePicture")
      .populate("lastMessage")
      .lean();

    // Attach unread count per conversation
    const withUnread = await Promise.all(
      conversations.map(async (conv) => {
        const unreadCount = await Message.countDocuments({
          conversation: conv._id,
          sender: { $ne: req.user._id },
          read: false,
        });
        return { ...conv, unreadCount };
      })
    );

    res.json(withUnread);
  } catch (err) {
    console.error("getConversations error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * GET /api/chats/:conversationId/messages?skip=0&limit=20
 * Returns paginated messages for a conversation, newest first.
 */
exports.getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId))
      return res.status(400).json({ message: "Invalid conversation id" });

    // Ensure the user is a participant
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.user._id,
    });
    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

    let skip = Number(req.query.skip) || 0;
    let limit = Number(req.query.limit) || 20;
    if (limit > 50) limit = 50;

    const messages = await Message.find({ conversation: conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "username name profilePicture")
      .lean();

    res.json(messages.reverse());
  } catch (err) {
    console.error("getMessages error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/chats/send
 * Body: { recipientId, text }
 * Creates a conversation if one doesn't exist, then saves the message.
 * Emits chat:message to the recipient via socket.
 */
exports.sendMessage = async (req, res) => {
  try {
    const { recipientId, text } = req.body;

    if (!recipientId || !text?.trim())
      return res.status(400).json({ message: "recipientId and text are required" });

    if (!mongoose.Types.ObjectId.isValid(recipientId))
      return res.status(400).json({ message: "Invalid recipientId" });

    if (String(recipientId) === String(req.user._id))
      return res.status(400).json({ message: "Cannot message yourself" });

    // Sort participants so the pair is always stored in the same order
    const participants = [req.user._id, recipientId].sort();

    // Find or create the conversation
    let conversation = await Conversation.findOne({
      participants: { $all: participants, $size: 2 },
    });

    if (!conversation) {
      conversation = await Conversation.create({ participants });
    }

    const message = await Message.create({
      conversation: conversation._id,
      sender: req.user._id,
      text: text.trim(),
    });

    // Update lastMessage and updatedAt on the conversation
    conversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      { lastMessage: message._id },
      { new: true }
    )
      .populate("participants", "username name profilePicture")
      .populate("lastMessage");

    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "username name profilePicture")
      .lean();

    // Emit to recipient's socket room
    io().to(String(recipientId)).emit("chat:message", {
      message: populatedMessage,
      conversation,
    });

    res.status(201).json({ message: populatedMessage, conversation });
  } catch (err) {
    console.error("sendMessage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * PATCH /api/chats/:conversationId/read
 * Marks all unread messages in the conversation (sent by the other user) as read.
 * Emits chat:read to the other participant.
 */
exports.markRead = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId))
      return res.status(400).json({ message: "Invalid conversation id" });

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.user._id,
    });
    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

    await Message.updateMany(
      { conversation: conversationId, sender: { $ne: req.user._id }, read: false },
      { $set: { read: true } }
    );

    // Notify the other participant that their messages were read
    const otherId = conversation.participants.find(
      (p) => String(p) !== String(req.user._id)
    );
    io().to(String(otherId)).emit("chat:read", {
      conversationId,
      readBy: req.user._id,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("markRead error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
