#!/bin/bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                               igor@igoros.com
#                                  2024-03-14
# -----------------------------------------------------------------------------
# Rename photos to show geo location
# -----------------------------------------------------------------------------
# Change Log:
# *****************************************************************************
# 2024-03-14  igor      Working as hard as a cat trying to bury a turd on a
#                       marble floor
# *****************************************************************************
configure() {
  v='v1.7'
  apibase="https://api.geocod.io/${v}"
  api_key="Get your API key from https://www.geocod.io"
}

convert_function_xt3() {
  echo "Saving original filename as a tag in "
  exiftool -P -overwrite_original_in_place '-XMP-xmpMM:PreservedFileName<${filename;s/\.[^.]*$//}' ""
  echo "Renaming "
  exiftool '-filename<${CreateDate}-${model;s/[- ]//g;tr/A-Z/a-z/}.%le' -d "%Y%m%d-%H%M%%-03.c-$(curl -s0 -q -k "${apibase}/reverse?q=$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "")&api_key=${api_key}&limit=1" | jq -r '.results[]|.address_components|"\(.city) \(.state) \(.country)"' 2>/dev/null | sed -e 's/\(.*\)/\L/' -e 's/[^A-Za-z0-9._-]/_/g')" ""
}

export -f convert_function_xt3

convert_function_iphone() {
  echo "Saving original filename as a tag in "
  exiftool -P -overwrite_original_in_place '-XMP-xmpMM:PreservedFileName<${filename;s/\.[^.]*$//}' ""
  echo "Renaming "
  exiftool '-filename<${DateTimeOriginal}-${model;s/[- ]//g;tr/A-Z/a-z/}.%le' \
  -d "%Y%m%d-%H%M%%-03.c-$(curl -s0 -q -k "${apibase}/reverse?q=$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "")&api_key=${api_key}&limit=1" | \
  jq -r '.results[]|.address_components|"\(.city) \(.state) \(.country)"' 2>/dev/null | sed -e 's/[^A-Za-z0-9._-]/_/g')" ""
}

export -f convert_function_iphone

rename_photos_in_current_folder_xt3() {
  find . -mindepth 1 -maxdepth 1 -type f -iname "*\.jpg" | while read file_name
  do
    echo "Saving original filename as a tag in ${file_name}"
    exiftool -P -overwrite_original_in_place '-XMP-xmpMM:PreservedFileName<${filename;s/\.[^.]*$//}' "${file_name}"
    
    echo "Renaming ${file_name}"
    exiftool '-filename<${CreateDate}-${model;s/[- ]//g;tr/A-Z/a-z/}.%le' -d "%Y%m%d-%H%M%%-03.c-$(curl -s0 -q -k "${apibase}/reverse?q=$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "${file_name}")&api_key=${api_key}&limit=1" | jq -r '.results[]|.address_components|"\(.city) \(.state) \(.country)"' 2>/dev/null | sed -e 's/\(.*\)/\L/' -e 's/[^A-Za-z0-9._-]/_/g')" "${file_name}"
    done
}

rename_photos_in_current_folder_iphone() {
  find . -mindepth 1 -maxdepth 1 -type f -iname "*\.jpg" | while read file_name
  do
    echo "Saving original filename as a tag in ${file_name}"
    exiftool -P -overwrite_original_in_place '-XMP-xmpMM:PreservedFileName<${filename;s/\.[^.]*$//}' "${file_name}"
    
    echo "Renaming ${file_name}"
    exiftool '-filename<${DateTimeOriginal}-${model;s/[- ]//g;tr/A-Z/a-z/}.%le' \
    -d "%Y%m%d-%H%M%%-03.c-$(curl -s0 -q -k "${apibase}/reverse?q=$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "${file_name}")&api_key=${api_key}&limit=1" | \
    jq -r '.results[]|.address_components|"\(.city) \(.state) \(.country)"' 2>/dev/null | sed -e 's/[^A-Za-z0-9._-]/_/g')" "${file_name}"
  done
}

rename_photos_in_current_folder_xargs_iphone() {
  find . -mindepth 1 -maxdepth 1 -type f -iname "*\.jpg" -print0 | xargs -r0 -n1 -P$(grep -c proc /proc/cpuinfo) -I {} bash -c 'convert_function_iphone "$@"' _ {}
}

move_photos_to_structure_one() {
  # .
  # └── 2020
  #     ├── 2020-07-18
  #     ├── 2020-07-21
  #     └── 2020-07-31
  exiftool "-Directory<DateTimeOriginal" -d "%Y/%Y-%m-%d" .
}

move_photos_to_structure_two() {
  #   .
  # └── 2020
  #     └── 2020-07
  exiftool "-Directory<DateTimeOriginal" -d "%Y/%Y-%m" .
}

# -----------------------------------------------------------------------------
# RUNTIME
# \(^_^)/                                      __|__
#                                     __|__ *---o0o---*
#                            __|__ *---o0o---*
#                         *---o0o---*
# -----------------------------------------------------------------------------
configure