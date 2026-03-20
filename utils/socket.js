// socket.js
const { Server } = require("socket.io");

let io;

// Tracks online users: userId (string) -> Set of socketIds
// A user can have multiple tabs open, so we use a Set
const onlineUsers = new Map();

exports.init = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "*",
      methods: ["GET", "POST", "PATCH"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const { userId } = socket.handshake.query;

    if (userId) {
      socket.join(userId);

      // Track online presence
      if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
      onlineUsers.get(userId).add(socket.id);

      // Broadcast to everyone that this user is online
      socket.broadcast.emit("user:online", { userId });
    }

    // Relay typing indicator to the recipient
    socket.on("chat:typing", ({ recipientId, conversationId, isTyping }) => {
      if (!recipientId || !conversationId) return;
      io.to(String(recipientId)).emit("chat:typing", {
        conversationId,
        userId,
        isTyping,
      });
    });

    socket.on("disconnect", () => {
      if (userId) {
        const sockets = onlineUsers.get(userId);
        if (sockets) {
          sockets.delete(socket.id);
          // Only broadcast offline when the user has no remaining connections
          if (sockets.size === 0) {
            onlineUsers.delete(userId);
            socket.broadcast.emit("user:offline", { userId });
          }
        }
      }
    });
  });

  return io;
};

exports.io = () => {
  if (!io) throw new Error("Socket.io not initialised");
  return io;
};

// Returns a Set of currently online userIds
exports.getOnlineUsers = () => new Set(onlineUsers.keys());
