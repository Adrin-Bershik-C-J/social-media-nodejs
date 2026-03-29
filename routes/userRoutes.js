const express = require("express");
const router = express.Router();
const {
  getProfile,
  updateProfile,
  toggleFollow,
  getFollowers,
  getFollowing,
  uploadProfilePicture,
  getHomeFollowers,
  getUserDetails,
} = require("../controllers/userController");
const protect = require("../middlewares/authMiddleware");
const upload = require("../middlewares/upload");

router.get("/me", protect, getProfile);
router.put("/update", protect, updateProfile);
router.post("/follow/:id", protect, toggleFollow);
router.get("/followers", protect, getFollowers);
router.get("/following", protect, getFollowing);
router.put(
  "/upload-profile-picture",
  protect,
  upload.single("profilePic"),
  uploadProfilePicture
);
router.get("/getHomeFollowers", protect, getHomeFollowers);
router.get("/user/:username",protect, getUserDetails);

module.exports = router;
