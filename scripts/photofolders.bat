@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_NAME=%~nx0"
set "SCRIPT_DIR=%~dp0"
set "DEFAULT_ROOT=%USERPROFILE%\Pictures\Photography"
set "DEFAULT_CONFIG=%SCRIPT_DIR%photofolders.config.cmd"

set "ROOT_DIR="
set "PROJECT_NAME="
set "CONFIG_FILE="
set "DRY_RUN=0"
set "SHOW_HELP=0"

call :parse_args %*
if errorlevel 1 exit /b 1

if "%SHOW_HELP%"=="1" (
  call :usage
  exit /b 0
)

if not defined ROOT_DIR (
  if defined PHOTOSHELL_ROOT (
    set "ROOT_DIR=%PHOTOSHELL_ROOT%"
  ) else (
    set "ROOT_DIR=%DEFAULT_ROOT%"
  )
)

if not defined CONFIG_FILE set "CONFIG_FILE=%DEFAULT_CONFIG%"
call :load_config "%CONFIG_FILE%"
if errorlevel 1 exit /b 1

if not defined PROJECT_NAME call :prompt_project
if not defined PROJECT_NAME (
  echo Error: project name is required.
  echo.
  call :usage
  exit /b 1
)

call :validate_segment "%PROJECT_NAME%" "project name"
if errorlevel 1 exit /b 1

set "BASE_DIR=%ROOT_DIR%\%PROJECT_NAME%"
set /a CREATED=0
set /a EXISTING=0

echo Project folder setup
echo   Project: "%PROJECT_NAME%"
echo   Root:    "%ROOT_DIR%"
echo   Config:  "%CONFIG_FILE%"
if "%DRY_RUN%"=="1" echo   Mode:    dry-run
echo.

call :build_tree
if errorlevel 1 exit /b 1

echo.
if "%DRY_RUN%"=="1" (
  echo Dry run complete: %CREATED% folder^(s^) would be created, %EXISTING% already exist.
) else (
  echo Complete: %CREATED% folder^(s^) created, %EXISTING% already existed.
)
exit /b 0

:usage
echo Usage:
echo   %SCRIPT_NAME% [project_name] [options]
echo.
echo Options:
echo   -p, --project NAME   Project name. If omitted, script prompts for it.
echo   -r, --root PATH      Root archive folder.
echo                         Default: PHOTOSHELL_ROOT or %DEFAULT_ROOT%
echo   -c, --config PATH    External folder template config file.
echo                         Default: %DEFAULT_CONFIG%
echo   -n, --dry-run        Show folders that would be created.
echo   -h, --help           Show this help.
echo.
echo Examples:
echo   %SCRIPT_NAME% "Iceland Trip 2026"
echo   %SCRIPT_NAME% --project "Wedding_Boston" --root "D:\Photos"
echo   %SCRIPT_NAME% "ClientA" --config "D:\Templates\photofolders.config.cmd"
echo   %SCRIPT_NAME% "ClientA" --dry-run
exit /b 0

:parse_args
if "%~1"=="" exit /b 0

if /I "%~1"=="-h" (
  set "SHOW_HELP=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--help" (
  set "SHOW_HELP=1"
  shift
  goto :parse_args
)
if /I "%~1"=="/?" (
  set "SHOW_HELP=1"
  shift
  goto :parse_args
)
if /I "%~1"=="-n" (
  set "DRY_RUN=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=1"
  shift
  goto :parse_args
)
if /I "%~1"=="-p" (
  if "%~2"=="" (
    echo Error: -p requires a project name.
    exit /b 1
  )
  set "PROJECT_NAME=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--project" (
  if "%~2"=="" (
    echo Error: --project requires a project name.
    exit /b 1
  )
  set "PROJECT_NAME=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="-r" (
  if "%~2"=="" (
    echo Error: -r requires a root path.
    exit /b 1
  )
  set "ROOT_DIR=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--root" (
  if "%~2"=="" (
    echo Error: --root requires a root path.
    exit /b 1
  )
  set "ROOT_DIR=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="-c" (
  if "%~2"=="" (
    echo Error: -c requires a config path.
    exit /b 1
  )
  set "CONFIG_FILE=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--config" (
  if "%~2"=="" (
    echo Error: --config requires a config path.
    exit /b 1
  )
  set "CONFIG_FILE=%~2"
  shift
  shift
  goto :parse_args
)

set "FIRST=%~1"
set "FIRST=%FIRST:~0,1%"
if "%FIRST%"=="-" (
  echo Error: unknown option "%~1".
  echo.
  call :usage
  exit /b 1
)

if defined PROJECT_NAME (
  echo Error: project name was already set to "%PROJECT_NAME%".
  exit /b 1
)

set "PROJECT_NAME=%~1"
shift
goto :parse_args

:prompt_project
set /p "PROJECT_NAME=Project name: "
exit /b 0

:load_config
set "CONFIG_PATH=%~1"
if "%CONFIG_PATH%"=="" (
  echo Error: config path is empty.
  exit /b 1
)
if not exist "%CONFIG_PATH%" (
  echo Error: config file not found: "%CONFIG_PATH%"
  exit /b 1
)

for /f "tokens=1 delims==" %%V in ('set CFG_ 2^>nul') do set "%%V="
call "%CONFIG_PATH%"
if errorlevel 1 (
  echo Error: failed to load config file: "%CONFIG_PATH%"
  exit /b 1
)

if not defined CFG_CATEGORY_IDS (
  echo Error: CFG_CATEGORY_IDS is not defined in config.
  exit /b 1
)
if not defined CFG_PROCESSED_SUBFOLDERS (
  echo Error: CFG_PROCESSED_SUBFOLDERS is not defined in config.
  exit /b 1
)

call :validate_config
if errorlevel 1 exit /b 1
exit /b 0

:validate_config
set "CATEGORY_LIST=%CFG_CATEGORY_IDS%"
:validate_category_loop
call :split_first "%CATEGORY_LIST%" "VCAT"
if not defined VCAT_ITEM goto :validate_category_done

set "CATEGORY_ID=%VCAT_ITEM%"
call set "CATEGORY_PATH=%%CFG_CATEGORY_PATH_%CATEGORY_ID%%%"
call set "EQUIPMENT_LIST=%%CFG_CATEGORY_EQUIPMENT_%CATEGORY_ID%%%"
call set "SUBFOLDER_LIST=%%CFG_CATEGORY_SUBFOLDERS_%CATEGORY_ID%%%"

if not defined CATEGORY_PATH (
  echo Error: missing CFG_CATEGORY_PATH_%CATEGORY_ID% in config.
  exit /b 1
)
if not defined EQUIPMENT_LIST (
  echo Error: missing CFG_CATEGORY_EQUIPMENT_%CATEGORY_ID% in config.
  exit /b 1
)
if not defined SUBFOLDER_LIST (
  echo Error: missing CFG_CATEGORY_SUBFOLDERS_%CATEGORY_ID% in config.
  exit /b 1
)

call :validate_segment "%CATEGORY_PATH%" "category path %CATEGORY_ID%"
if errorlevel 1 exit /b 1

set "CATEGORY_LIST=%VCAT_REST%"
if defined CATEGORY_LIST goto :validate_category_loop
:validate_category_done
exit /b 0

:build_tree
call :add_dir "originals" || exit /b 1

set "CATEGORY_LIST=%CFG_CATEGORY_IDS%"
:build_category_loop
call :split_first "%CATEGORY_LIST%" "CAT"
if not defined CAT_ITEM goto :build_processed

call :build_category "%CAT_ITEM%"
if errorlevel 1 exit /b 1

set "CATEGORY_LIST=%CAT_REST%"
if defined CATEGORY_LIST goto :build_category_loop

:build_processed
call :add_dir "processed" || exit /b 1

set "PROCESSED_LIST=%CFG_PROCESSED_SUBFOLDERS%"
:processed_loop
call :split_first "%PROCESSED_LIST%" "PROC"
if not defined PROC_ITEM goto :build_done

call :add_dir "processed\%PROC_ITEM%" || exit /b 1
set "PROCESSED_LIST=%PROC_REST%"
if defined PROCESSED_LIST goto :processed_loop

:build_done
exit /b 0

:build_category
set "CATEGORY_ID=%~1"
call set "CATEGORY_PATH=%%CFG_CATEGORY_PATH_%CATEGORY_ID%%%"
call set "EQUIPMENT_LIST=%%CFG_CATEGORY_EQUIPMENT_%CATEGORY_ID%%%"
call set "SUBFOLDER_LIST=%%CFG_CATEGORY_SUBFOLDERS_%CATEGORY_ID%%%"

call :add_dir "originals\%CATEGORY_PATH%" || exit /b 1

:equipment_loop
call :split_first "%EQUIPMENT_LIST%" "EQ"
if not defined EQ_ITEM goto :build_category_done

set "EQUIPMENT_NAME=%EQ_ITEM%"
call :validate_segment "%EQUIPMENT_NAME%" "equipment name %CATEGORY_ID%"
if errorlevel 1 exit /b 1

call :add_dir "originals\%CATEGORY_PATH%\%EQUIPMENT_NAME%" || exit /b 1

set "CATEGORY_SUBS=%SUBFOLDER_LIST%"
:subfolder_loop
call :split_first "%CATEGORY_SUBS%" "SUB"
if not defined SUB_ITEM goto :next_equipment

call :add_dir "originals\%CATEGORY_PATH%\%EQUIPMENT_NAME%\%SUB_ITEM%" || exit /b 1
set "CATEGORY_SUBS=%SUB_REST%"
if defined CATEGORY_SUBS goto :subfolder_loop

:next_equipment
set "EQUIPMENT_LIST=%EQ_REST%"
if defined EQUIPMENT_LIST goto :equipment_loop

:build_category_done
exit /b 0

:split_first
set "%~2_ITEM="
set "%~2_REST="

if "%~1"=="" exit /b 0
for /f "tokens=1* delims=;" %%A in ("%~1") do (
  set "%~2_ITEM=%%~A"
  set "%~2_REST=%%~B"
)
exit /b 0

:validate_segment
set "SEGMENT_VALUE=%~1"
set "SEGMENT_LABEL=%~2"

if "%SEGMENT_VALUE%"=="" (
  echo Error: empty %SEGMENT_LABEL%.
  exit /b 1
)
if /I "%SEGMENT_VALUE%"=="." (
  echo Error: invalid %SEGMENT_LABEL% ".".
  exit /b 1
)
if /I "%SEGMENT_VALUE%"==".." (
  echo Error: invalid %SEGMENT_LABEL% "..".
  exit /b 1
)

echo(%SEGMENT_VALUE%| findstr /r "[\\/:*?<>|]" >nul
if not errorlevel 1 (
  echo Error: invalid %SEGMENT_LABEL% "%SEGMENT_VALUE%".
  exit /b 1
)
exit /b 0

:add_dir
set "REL_PATH=%~1"
if "%REL_PATH%"=="" exit /b 0

set "TARGET=%BASE_DIR%\%REL_PATH%"
if exist "%TARGET%\" (
  set /a EXISTING+=1
  echo [exists] "%TARGET%"
  exit /b 0
)

if "%DRY_RUN%"=="1" (
  set /a CREATED+=1
  echo [plan]   "%TARGET%"
  exit /b 0
)

mkdir "%TARGET%" 2>nul
if errorlevel 1 (
  echo Error: failed to create "%TARGET%".
  exit /b 1
)

set /a CREATED+=1
echo [create] "%TARGET%"
exit /b 0
