// socket.js
const { Server } = require("socket.io");

let io;

// Tracks online users: userId (string) -> Set of socketIds
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
    
    console.log(`Socket connected: ${socket.id}, userId: ${userId}`);

    if (userId && userId !== "undefined" && userId !== "null") {
      socket.userId = userId;
      socket.join(userId);

      // Track online presence
      if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
      }
      onlineUsers.get(userId).add(socket.id);

      console.log(`User ${userId} online. Total connections: ${onlineUsers.get(userId).size}`);

      // Send current online users to the newly connected user
      const currentOnlineUsers = Array.from(onlineUsers.keys());
      socket.emit("users:online", { userIds: currentOnlineUsers });

      // Broadcast to everyone else that this user is online
      socket.broadcast.emit("user:online", { userId });
    }

    // Relay typing indicator to the recipient
    socket.on("chat:typing", ({ recipientId, conversationId, isTyping }) => {
      if (!recipientId || !conversationId) return;
      io.to(String(recipientId)).emit("chat:typing", {
        conversationId,
        userId: socket.userId,
        isTyping,
      });
    });

    // Handle manual disconnect (logout/close)
    socket.on("user:disconnect", () => {
      handleDisconnect(socket);
    });

    // Handle automatic disconnect
    socket.on("disconnect", () => {
      handleDisconnect(socket);
    });
  });

  return io;
};

// Centralized disconnect handler
function handleDisconnect(socket) {
  const userId = socket.userId;
  
  if (!userId) return;

  console.log(`Socket disconnected: ${socket.id}, userId: ${userId}`);

  const sockets = onlineUsers.get(userId);
  if (sockets) {
    sockets.delete(socket.id);
    console.log(`User ${userId} remaining connections: ${sockets.size}`);
    
    // Only broadcast offline when the user has no remaining connections
    if (sockets.size === 0) {
      onlineUsers.delete(userId);
      console.log(`User ${userId} is now offline`);
      io.emit("user:offline", { userId });
    }
  }
}

exports.io = () => {
  if (!io) throw new Error("Socket.io not initialised");
  return io;
};

// Returns a Set of currently online userIds
exports.getOnlineUsers = () => new Set(onlineUsers.keys());
