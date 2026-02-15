#!/usr/bin/env bash

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="${HOME}/Pictures/Photography"
DEFAULT_CONFIG="${SCRIPT_DIR}/photofolders.config.sh"

ROOT_DIR=""
PROJECT_NAME=""
CONFIG_FILE=""
DRY_RUN=0
SHOW_HELP=0
CREATED=0
EXISTING=0

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [project_name] [options]

Options:
  -p, --project NAME   Project name. If omitted, script prompts for it.
  -r, --root PATH      Root archive folder.
                        Default: PHOTOSHELL_ROOT or ${DEFAULT_ROOT}
  -c, --config PATH    External folder template config file.
                        Default: ${DEFAULT_CONFIG}
  -n, --dry-run        Show folders that would be created.
  -h, --help           Show this help.

Examples:
  ${SCRIPT_NAME} "Iceland Trip 2026"
  ${SCRIPT_NAME} --project "Wedding_Boston" --root "/mnt/photos"
  ${SCRIPT_NAME} "ClientA" --config "/opt/templates/photofolders.config.sh"
  ${SCRIPT_NAME} "ClientA" --dry-run
EOF
}

split_semicolon_list() {
  local list="$1"
  local -n out_ref="$2"
  IFS=';' read -r -a out_ref <<< "${list}"
}

validate_segment() {
  local value="$1"
  local label="$2"

  if [[ -z "${value}" ]]; then
    echo "Error: empty ${label}."
    return 1
  fi
  if [[ "${value}" == "." ]]; then
    echo "Error: invalid ${label} \".\"."
    return 1
  fi
  if [[ "${value}" == ".." ]]; then
    echo "Error: invalid ${label} \"..\"."
    return 1
  fi
  case "${value}" in
    *[\\/:*?\<\>\|]*)
      echo "Error: invalid ${label} \"${value}\"."
      return 1
      ;;
  esac

  return 0
}

validate_config() {
  local category_ids
  local category_id
  local path_var
  local equipment_var
  local subfolders_var
  local category_path
  local equipment_list
  local subfolder_list

  split_semicolon_list "${CFG_CATEGORY_IDS}" category_ids
  for category_id in "${category_ids[@]}"; do
    [[ -z "${category_id}" ]] && continue

    if [[ ! "${category_id}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Error: invalid category id \"${category_id}\". Use letters, numbers, and underscores."
      return 1
    fi

    path_var="CFG_CATEGORY_PATH_${category_id}"
    equipment_var="CFG_CATEGORY_EQUIPMENT_${category_id}"
    subfolders_var="CFG_CATEGORY_SUBFOLDERS_${category_id}"

    category_path="${!path_var-}"
    equipment_list="${!equipment_var-}"
    subfolder_list="${!subfolders_var-}"

    if [[ -z "${category_path}" ]]; then
      echo "Error: missing ${path_var} in config."
      return 1
    fi
    if [[ -z "${equipment_list}" ]]; then
      echo "Error: missing ${equipment_var} in config."
      return 1
    fi
    if [[ -z "${subfolder_list}" ]]; then
      echo "Error: missing ${subfolders_var} in config."
      return 1
    fi

    validate_segment "${category_path}" "category path ${category_id}" || return 1
  done

  return 0
}

load_config() {
  local config_path="$1"
  local var_name

  if [[ -z "${config_path}" ]]; then
    echo "Error: config path is empty."
    return 1
  fi
  if [[ ! -f "${config_path}" ]]; then
    echo "Error: config file not found: \"${config_path}\""
    return 1
  fi

  while IFS= read -r var_name; do
    unset "${var_name}"
  done < <(compgen -A variable CFG_ || true)

  # shellcheck disable=SC1090
  if ! source "${config_path}"; then
    echo "Error: failed to load config file: \"${config_path}\""
    return 1
  fi

  if [[ -z "${CFG_CATEGORY_IDS-}" ]]; then
    echo "Error: CFG_CATEGORY_IDS is not defined in config."
    return 1
  fi
  if [[ -z "${CFG_PROCESSED_SUBFOLDERS-}" ]]; then
    echo "Error: CFG_PROCESSED_SUBFOLDERS is not defined in config."
    return 1
  fi

  validate_config || return 1
  return 0
}

prompt_project() {
  read -r -p "Project name: " PROJECT_NAME
}

normalize_rel_path() {
  local path="$1"
  echo "${path//\\//}"
}

add_dir() {
  local rel_path="$1"
  local normalized
  local target

  [[ -z "${rel_path}" ]] && return 0

  normalized="$(normalize_rel_path "${rel_path}")"
  target="${BASE_DIR}/${normalized}"

  if [[ -d "${target}" ]]; then
    EXISTING=$((EXISTING + 1))
    echo "[exists] \"${target}\""
    return 0
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    CREATED=$((CREATED + 1))
    echo "[plan]   \"${target}\""
    return 0
  fi

  if ! mkdir -p "${target}"; then
    echo "Error: failed to create \"${target}\"."
    return 1
  fi

  CREATED=$((CREATED + 1))
  echo "[create] \"${target}\""
  return 0
}

build_category() {
  local category_id="$1"
  local path_var="CFG_CATEGORY_PATH_${category_id}"
  local equipment_var="CFG_CATEGORY_EQUIPMENT_${category_id}"
  local subfolders_var="CFG_CATEGORY_SUBFOLDERS_${category_id}"
  local category_path="${!path_var-}"
  local equipment_list="${!equipment_var-}"
  local subfolder_list="${!subfolders_var-}"
  local equipment_names
  local category_subfolders
  local equipment_name
  local subfolder

  add_dir "originals/${category_path}" || return 1

  split_semicolon_list "${equipment_list}" equipment_names
  split_semicolon_list "${subfolder_list}" category_subfolders

  for equipment_name in "${equipment_names[@]}"; do
    [[ -z "${equipment_name}" ]] && continue
    validate_segment "${equipment_name}" "equipment name ${category_id}" || return 1

    add_dir "originals/${category_path}/${equipment_name}" || return 1
    for subfolder in "${category_subfolders[@]}"; do
      [[ -z "${subfolder}" ]] && continue
      add_dir "originals/${category_path}/${equipment_name}/${subfolder}" || return 1
    done
  done

  return 0
}

build_tree() {
  local category_ids
  local category_id
  local processed_list
  local processed_subfolder

  add_dir "originals" || return 1

  split_semicolon_list "${CFG_CATEGORY_IDS}" category_ids
  for category_id in "${category_ids[@]}"; do
    [[ -z "${category_id}" ]] && continue
    build_category "${category_id}" || return 1
  done

  add_dir "processed" || return 1

  split_semicolon_list "${CFG_PROCESSED_SUBFOLDERS}" processed_list
  for processed_subfolder in "${processed_list[@]}"; do
    [[ -z "${processed_subfolder}" ]] && continue
    add_dir "processed/${processed_subfolder}" || return 1
  done

  return 0
}

parse_args() {
  local first_char

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help|'/?')
        SHOW_HELP=1
        shift
        ;;
      -n|--dry-run)
        DRY_RUN=1
        shift
        ;;
      -p|--project)
        if [[ $# -lt 2 ]]; then
          echo "Error: $1 requires a project name."
          return 1
        fi
        PROJECT_NAME="$2"
        shift 2
        ;;
      --project=*)
        PROJECT_NAME="${1#*=}"
        shift
        ;;
      -r|--root)
        if [[ $# -lt 2 ]]; then
          echo "Error: $1 requires a root path."
          return 1
        fi
        ROOT_DIR="$2"
        shift 2
        ;;
      --root=*)
        ROOT_DIR="${1#*=}"
        shift
        ;;
      -c|--config)
        if [[ $# -lt 2 ]]; then
          echo "Error: $1 requires a config path."
          return 1
        fi
        CONFIG_FILE="$2"
        shift 2
        ;;
      --config=*)
        CONFIG_FILE="${1#*=}"
        shift
        ;;
      --)
        shift
        break
        ;;
      *)
        first_char="${1:0:1}"
        if [[ "${first_char}" == "-" ]]; then
          echo "Error: unknown option \"$1\"."
          echo
          usage
          return 1
        fi
        if [[ -n "${PROJECT_NAME}" ]]; then
          echo "Error: project name was already set to \"${PROJECT_NAME}\"."
          return 1
        fi
        PROJECT_NAME="$1"
        shift
        ;;
    esac
  done

  if [[ $# -gt 0 ]]; then
    if [[ -n "${PROJECT_NAME}" ]]; then
      echo "Error: project name was already set to \"${PROJECT_NAME}\"."
      return 1
    fi
    PROJECT_NAME="$1"
    shift
  fi

  if [[ $# -gt 0 ]]; then
    echo "Error: unexpected argument \"$1\"."
    return 1
  fi

  return 0
}

main() {
  parse_args "$@" || return 1

  if [[ "${SHOW_HELP}" -eq 1 ]]; then
    usage
    return 0
  fi

  if [[ -z "${ROOT_DIR}" ]]; then
    if [[ -n "${PHOTOSHELL_ROOT-}" ]]; then
      ROOT_DIR="${PHOTOSHELL_ROOT}"
    else
      ROOT_DIR="${DEFAULT_ROOT}"
    fi
  fi

  if [[ -z "${CONFIG_FILE}" ]]; then
    CONFIG_FILE="${DEFAULT_CONFIG}"
  fi

  load_config "${CONFIG_FILE}" || return 1

  if [[ -z "${PROJECT_NAME}" ]]; then
    prompt_project
  fi
  if [[ -z "${PROJECT_NAME}" ]]; then
    echo "Error: project name is required."
    echo
    usage
    return 1
  fi

  validate_segment "${PROJECT_NAME}" "project name" || return 1

  BASE_DIR="${ROOT_DIR}/${PROJECT_NAME}"

  echo "Project folder setup"
  echo "  Project: \"${PROJECT_NAME}\""
  echo "  Root:    \"${ROOT_DIR}\""
  echo "  Config:  \"${CONFIG_FILE}\""
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  Mode:    dry-run"
  fi
  echo

  build_tree || return 1

  echo
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "Dry run complete: ${CREATED} folder(s) would be created, ${EXISTING} already exist."
  else
    echo "Complete: ${CREATED} folder(s) created, ${EXISTING} already existed."
  fi

  return 0
}

main "$@"
