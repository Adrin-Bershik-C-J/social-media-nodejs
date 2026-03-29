const router = require("express").Router();
const protect = require("../middlewares/authMiddleware");
const {
  getConversations,
  getMessages,
  sendMessage,
  markRead,
} = require("../controllers/chatController");

router.use(protect);

router.get("/", getConversations);
router.get("/:conversationId/messages", getMessages);
router.post("/send", sendMessage);
router.patch("/:conversationId/read", markRead);

module.exports = router;
