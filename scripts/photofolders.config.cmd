@echo off
rem PhotoShell folder template configuration
rem ---------------------------------------------------------------------------
rem List delimiter is semicolon (;)
rem
rem Required variables:
rem   CFG_CATEGORY_IDS
rem   CFG_CATEGORY_PATH_<id>
rem   CFG_CATEGORY_EQUIPMENT_<id>
rem   CFG_CATEGORY_SUBFOLDERS_<id>
rem   CFG_PROCESSED_SUBFOLDERS
rem ---------------------------------------------------------------------------

rem 1) Equipment categories
set "CFG_CATEGORY_IDS=cell_phones;photo_cameras;drones;video_cameras"

rem 2) Standardized subfolders for original media by category
set "CFG_CATEGORY_PATH_cell_phones=cell_phones"
set "CFG_CATEGORY_EQUIPMENT_cell_phones=iPhone"
set "CFG_CATEGORY_SUBFOLDERS_cell_phones=photos;photos\jpg;photos\raw;photos\panoramas;videos;videos\original;videos\clips"

set "CFG_CATEGORY_PATH_photo_cameras=photo_cameras"
set "CFG_CATEGORY_EQUIPMENT_photo_cameras=X-T3;Z9;D750"
set "CFG_CATEGORY_SUBFOLDERS_photo_cameras=photos;photos\jpg;photos\raw;photos\dng;photos\panoramas;videos;videos\original;videos\clips"

set "CFG_CATEGORY_PATH_drones=drones"
set "CFG_CATEGORY_EQUIPMENT_drones=DJI"
set "CFG_CATEGORY_SUBFOLDERS_drones=photos;photos\jpg;photos\raw;photos\dng;videos;videos\original;videos\clips"

set "CFG_CATEGORY_PATH_video_cameras=video_cameras"
set "CFG_CATEGORY_EQUIPMENT_video_cameras=GoPro;Insta360"
set "CFG_CATEGORY_SUBFOLDERS_video_cameras=photos;photos\jpg;videos;videos\original;videos\clips;videos\geo_renamed;videos\lrv;videos\thm"

rem 3) Standardized processed output folders
set "CFG_PROCESSED_SUBFOLDERS=photos;photos\working;photos\exports;photos\exports\full;photos\exports\web;social;social\instagram;social\instagram\queued;social\instagram\posted;stock;stock\adobe;stock\adobe\submitted;stock\adobe\submitted\accepted;stock\adobe\submitted\rejected"
