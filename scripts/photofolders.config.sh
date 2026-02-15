# PhotoShell folder template configuration (Bash)
# ---------------------------------------------------------------------------
# List delimiter is semicolon (;)
#
# Required variables:
#   CFG_CATEGORY_IDS
#   CFG_CATEGORY_PATH_<id>
#   CFG_CATEGORY_EQUIPMENT_<id>
#   CFG_CATEGORY_SUBFOLDERS_<id>
#   CFG_PROCESSED_SUBFOLDERS
# ---------------------------------------------------------------------------

# 1) Equipment categories
CFG_CATEGORY_IDS="cell_phones;photo_cameras;drones;video_cameras"

# 2) Standardized subfolders for original media by category
CFG_CATEGORY_PATH_cell_phones="cell_phones"
CFG_CATEGORY_EQUIPMENT_cell_phones="iPhone"
CFG_CATEGORY_SUBFOLDERS_cell_phones="photos;photos/jpg;photos/raw;photos/panoramas;videos;videos/original;videos/clips"

CFG_CATEGORY_PATH_photo_cameras="photo_cameras"
CFG_CATEGORY_EQUIPMENT_photo_cameras="X-T3;Z9;D750"
CFG_CATEGORY_SUBFOLDERS_photo_cameras="photos;photos/jpg;photos/raw;photos/dng;photos/panoramas;videos;videos/original;videos/clips"

CFG_CATEGORY_PATH_drones="drones"
CFG_CATEGORY_EQUIPMENT_drones="DJI"
CFG_CATEGORY_SUBFOLDERS_drones="photos;photos/jpg;photos/raw;photos/dng;videos;videos/original;videos/clips"

CFG_CATEGORY_PATH_video_cameras="video_cameras"
CFG_CATEGORY_EQUIPMENT_video_cameras="GoPro;Insta360"
CFG_CATEGORY_SUBFOLDERS_video_cameras="photos;photos/jpg;videos;videos/original;videos/clips;videos/geo_renamed;videos/lrv;videos/thm"

# 3) Standardized processed output folders
CFG_PROCESSED_SUBFOLDERS="photos;photos/working;photos/exports;photos/exports/full;photos/exports/web;social;social/instagram;social/instagram/queued;social/instagram/posted;stock;stock/adobe;stock/adobe/submitted;stock/adobe/submitted/accepted;stock/adobe/submitted/rejected"
