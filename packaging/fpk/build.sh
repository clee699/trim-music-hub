#!/usr/bin/env bash
# Build script for TRIM Music Hub fnOS (.fpk) installer package.
# Supports three packaging modes:
#   - source : Universal (.fpk, platform=all) embedding clean source + Dockerfile (builds locally on NAS)
#   - online : Lightweight universal (.fpk, platform=all) pulling prebuilt multi-arch image with source fallback
#   - bundle : 100% offline (.fpk, platform=x86 or arm) embedding compressed Docker image tarball

set -euo pipefail

FPK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${FPK_DIR}/../.." && pwd)"

FNPACK_VERSION="${FNPACK_VERSION:-1.2.3}"
MODE="source"
VERSION=""
ARCH=""
IMAGE_REF=""
IMAGE_TAR=""
MAINTAINER="${FPK_MAINTAINER:-TRIM Music Hub}"
MAINTAINER_URL="${FPK_MAINTAINER_URL:-https://github.com}"
FNPACK_BIN="${FNPACK_BIN:-}"
OUT_DIR="${REPO_ROOT}/dist"
STAGE_ONLY_DIR=""

usage() {
  cat <<'EOF'
Usage: ./packaging/fpk/build.sh [options]

Options:
  --mode <source|online|bundle>   Packaging mode (default: source)
  --version <X.Y.Z>               Package version (default: packaging/fpk/VERSION)
  --arch <amd64|arm64>            Target architecture (required for --mode bundle)
  --image <repo/image:tag>        Prebuilt Docker image reference (required for --mode online; optional for bundle)
  --image-tar <path>              Existing Docker image .tar or .tar.gz for --mode bundle
  --maintainer <name>             Manifest maintainer name (default: "TRIM Music Hub")
  --maintainer-url <url>          Manifest maintainer URL
  --fnpack <path>                 Path to fnpack binary (auto-downloaded if omitted)
  --out <dir>                     Output directory for .fpk and .sha256 (default: ./dist)
  --stage-only <dir>              Only assemble staging directory without running fnpack
  -h, --help                      Show this help message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-}"; shift 2 ;;
    --version)
      VERSION="${2:-}"; shift 2 ;;
    --arch)
      ARCH="${2:-}"; shift 2 ;;
    --image)
      IMAGE_REF="${2:-}"; shift 2 ;;
    --image-tar)
      IMAGE_TAR="${2:-}"; shift 2 ;;
    --maintainer)
      MAINTAINER="${2:-}"; shift 2 ;;
    --maintainer-url)
      MAINTAINER_URL="${2:-}"; shift 2 ;;
    --fnpack)
      FNPACK_BIN="${2:-}"; shift 2 ;;
    --out)
      OUT_DIR="${2:-}"; shift 2 ;;
    --stage-only)
      STAGE_ONLY_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

if [ -z "${VERSION}" ]; then
  if [ -f "${FPK_DIR}/VERSION" ]; then
    VERSION="$(head -n 1 "${FPK_DIR}/VERSION" | tr -d '[:space:]')"
  else
    VERSION="2.0.2"
  fi
fi
VERSION="${VERSION#v}"

if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z._-]+)?$ ]]; then
  echo "Invalid version format: ${VERSION} (expected semver like 2.0.2)" >&2
  exit 1
fi

PLATFORM="all"
SUFFIX=""

case "${MODE}" in
  source)
    PLATFORM="all"
    SUFFIX=""
    ;;
  online)
    if [ -z "${IMAGE_REF}" ]; then
      echo "--mode online requires --image <registry/repo:tag>" >&2
      exit 1
    fi
    PLATFORM="all"
    SUFFIX="-online"
    ;;
  bundle)
    case "${ARCH}" in
      amd64|x86_64|x86)
        ARCH="amd64"
        PLATFORM="x86"
        SUFFIX="-amd64"
        ;;
      arm64|aarch64|arm)
        ARCH="arm64"
        PLATFORM="arm"
        SUFFIX="-arm64"
        ;;
      *)
        echo "--mode bundle requires --arch amd64 or --arch arm64" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported --mode '${MODE}' (must be source, online, or bundle)" >&2
    exit 1
    ;;
esac

resolve_fnpack() {
  if [ -n "${FNPACK_BIN}" ]; then
    if [ ! -x "${FNPACK_BIN}" ]; then
      echo "Specified fnpack binary is not executable: ${FNPACK_BIN}" >&2
      exit 1
    fi
    return 0
  fi

  if command -v fnpack >/dev/null 2>&1; then
    FNPACK_BIN="$(command -v fnpack)"
    return 0
  fi

  local cached="${REPO_ROOT}/.tools/fnpack"
  if [ -x "${cached}" ]; then
    FNPACK_BIN="${cached}"
    return 0
  fi

  local uname_s uname_m fn_os fn_arch
  uname_s="$(uname -s | tr '[:upper:]' '[:lower:]')"
  uname_m="$(uname -m)"
  case "${uname_s}" in
    linux*) fn_os="linux" ;;
    darwin*) fn_os="darwin" ;;
    *)
      echo "Unsupported OS '${uname_s}' for automatic fnpack download; pass --fnpack <path>." >&2
      exit 1 ;;
  esac
  case "${uname_m}" in
    x86_64|amd64) fn_arch="amd64" ;;
    aarch64|arm64) fn_arch="arm64" ;;
    *)
      echo "Unsupported CPU arch '${uname_m}' for automatic fnpack download; pass --fnpack <path>." >&2
      exit 1 ;;
  esac

  local url="https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-${fn_os}-${fn_arch}"
  echo "Downloading fnpack ${FNPACK_VERSION} (${fn_os}/${fn_arch})..."
  mkdir -p "$(dirname "${cached}")"
  curl -fsSL "${url}" -o "${cached}"
  chmod +x "${cached}"
  FNPACK_BIN="${cached}"
}

ensure_icons() {
  if [ ! -f "${FPK_DIR}/ICON.PNG" ] || [ ! -f "${FPK_DIR}/ICON_256.PNG" ] || \
     [ ! -f "${FPK_DIR}/app/ui/images/icon_64.png" ] || [ ! -f "${FPK_DIR}/app/ui/images/icon_256.png" ]; then
    python3 "${FPK_DIR}/generate_icons.py"
  fi
}

copy_clean_repo() {
  local dest_repo="$1"
  python3 - "${REPO_ROOT}" "${dest_repo}" <<'PY'
import os
import shutil
import sys

src_root, dst_root = sys.argv[1], sys.argv[2]
os.makedirs(dst_root, exist_ok=True)

EXCLUDE_TOP = {
    ".git",
    ".github",
    ".tools",
    ".vscode",
    ".idea",
    "data",
    "dist",
    "node_modules",
    "packaging",
    "__pycache__",
}
EXCLUDE_NAMES = {
    ".DS_Store",
    "__pycache__",
    "node_modules",
    "dist",
    ".env",
}


def should_skip(rel_path: str, name: str) -> bool:
    parts = rel_path.split(os.sep)
    if parts[0] in EXCLUDE_TOP:
        return True
    if name in EXCLUDE_NAMES:
        return True
    if (name.startswith(".env.") and name != ".env.example") or name.endswith((".pyc", ".log", ".pid", ".fpk", ".fpk.sha256")):
        return True
    return False


for root, dirs, files in os.walk(src_root):
    rel_dir = os.path.relpath(root, src_root)
    if rel_dir == ".":
        dirs[:] = [d for d in dirs if d not in EXCLUDE_TOP and d not in EXCLUDE_NAMES]
    else:
        dirs[:] = [d for d in dirs if not should_skip(os.path.join(rel_dir, d), d)]

    target_dir = dst_root if rel_dir == "." else os.path.join(dst_root, rel_dir)
    os.makedirs(target_dir, exist_ok=True)

    for fname in files:
        rel_file = fname if rel_dir == "." else os.path.join(rel_dir, fname)
        if should_skip(rel_file, fname):
            continue
        src_file = os.path.join(root, fname)
        if os.path.islink(src_file):
            continue
        dst_file = os.path.join(target_dir, fname)
        shutil.copy2(src_file, dst_file)
PY
}

ensure_icons

TEMP_ROOT=""
cleanup() {
  if [ -n "${TEMP_ROOT}" ] && [ -d "${TEMP_ROOT}" ]; then
    rm -rf "${TEMP_ROOT}"
  fi
}
trap cleanup EXIT

if [ -n "${STAGE_ONLY_DIR}" ]; then
  rm -rf "${STAGE_ONLY_DIR}"
  mkdir -p "${STAGE_ONLY_DIR}"
  STAGE_DIR="$(cd "${STAGE_ONLY_DIR}" && pwd)"
else
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/trim-music-hub-fpk.XXXXXX")"
  STAGE_DIR="${TEMP_ROOT}/stage"
  mkdir -p "${STAGE_DIR}"
fi

# 1. Assemble FPK skeleton
mkdir -p "${STAGE_DIR}/app" "${STAGE_DIR}/cmd" "${STAGE_DIR}/config" "${STAGE_DIR}/wizard"
cp "${FPK_DIR}/ICON.PNG" "${STAGE_DIR}/ICON.PNG"
cp "${FPK_DIR}/ICON_256.PNG" "${STAGE_DIR}/ICON_256.PNG"
cp -R "${FPK_DIR}/app/ui" "${STAGE_DIR}/app/ui"
cp -R "${FPK_DIR}/config/." "${STAGE_DIR}/config/"
cp -R "${FPK_DIR}/wizard/." "${STAGE_DIR}/wizard/"
cp -R "${FPK_DIR}/cmd/." "${STAGE_DIR}/cmd/"
chmod 0755 "${STAGE_DIR}/cmd/"*
[ -f "${REPO_ROOT}/LICENSE" ] && cp "${REPO_ROOT}/LICENSE" "${STAGE_DIR}/LICENSE" || true

# 2. Render manifest from manifest.in
python3 - "${FPK_DIR}/manifest.in" "${STAGE_DIR}/manifest" "${VERSION}" "${PLATFORM}" "${MAINTAINER}" "${MAINTAINER_URL}" <<'PY'
import sys

tpl_path, out_path, version, platform, maintainer, maintainer_url = sys.argv[1:7]
with open(tpl_path, "r", encoding="utf-8") as f:
    content = f.read()

replacements = {
    "@VERSION@": version,
    "@PLATFORM@": platform,
    "@MAINTAINER@": maintainer,
    "@MAINTAINER_URL@": maintainer_url,
}
for k, v in replacements.items():
    content = content.replace(k, v)

with open(out_path, "w", encoding="utf-8") as f:
    f.write(content)
PY

# 3. Populate app payload according to mode
if [ "${MODE}" = "source" ]; then
  echo "Staging clean repository source for on-NAS Docker build..."
  copy_clean_repo "${STAGE_DIR}/app/repo"
elif [ "${MODE}" = "online" ]; then
  echo "Configuring online prebuilt image (${IMAGE_REF}) with source fallback..."
  printf 'IMAGE_REF=%q\n' "${IMAGE_REF}" > "${STAGE_DIR}/app/image-ref.env"
  copy_clean_repo "${STAGE_DIR}/app/repo"
elif [ "${MODE}" = "bundle" ]; then
  mkdir -p "${STAGE_DIR}/app/image"
  BUNDLE_TAG="${IMAGE_REF:-trim-music-hub-fpk:${VERSION}-${ARCH}}"
  echo "${BUNDLE_TAG}" > "${STAGE_DIR}/app/image/image-tag.txt"

  if [ -n "${IMAGE_TAR}" ]; then
    if [ ! -f "${IMAGE_TAR}" ]; then
      echo "Image tar not found: ${IMAGE_TAR}" >&2
      exit 1
    fi
    echo "Embedding provided Docker image archive: ${IMAGE_TAR}"
    if [[ "${IMAGE_TAR}" == *.gz ]]; then
      cp "${IMAGE_TAR}" "${STAGE_DIR}/app/image/trim-music-hub-image.tar.gz"
    else
      gzip -c "${IMAGE_TAR}" > "${STAGE_DIR}/app/image/trim-music-hub-image.tar.gz"
    fi
  else
    echo "Building Docker image (${BUNDLE_TAG}) for linux/${ARCH}..."
    if docker buildx version >/dev/null 2>&1; then
      docker buildx build --platform "linux/${ARCH}" -t "${BUNDLE_TAG}" --load "${REPO_ROOT}"
    else
      docker build --platform "linux/${ARCH}" -t "${BUNDLE_TAG}" "${REPO_ROOT}"
    fi
    echo "Compressing Docker image into offline archive..."
    docker save "${BUNDLE_TAG}" | gzip -9 > "${STAGE_DIR}/app/image/trim-music-hub-image.tar.gz"
  fi
fi

# Clean any stray macOS metadata files that fail fnpack validation
find "${STAGE_DIR}" -name '.DS_Store' -delete 2>/dev/null || true

if [ -n "${STAGE_ONLY_DIR}" ]; then
  echo "Staged FPK directory ready at: ${STAGE_DIR}"
  exit 0
fi

resolve_fnpack

mkdir -p "${OUT_DIR}"
OUT_DIR_ABS="$(cd "${OUT_DIR}" && pwd)"
BUILD_WORK_DIR="${TEMP_ROOT}/out"
mkdir -p "${BUILD_WORK_DIR}"

echo "Packing .fpk with ${FNPACK_BIN}..."
(
  cd "${BUILD_WORK_DIR}"
  "${FNPACK_BIN}" build --directory "${STAGE_DIR}"
)

BUILT_FPK="$(find "${BUILD_WORK_DIR}" -maxdepth 1 -name '*.fpk' | head -n 1)"
if [ -z "${BUILT_FPK}" ] || [ ! -f "${BUILT_FPK}" ]; then
  echo "fnpack build did not produce an .fpk file!" >&2
  exit 1
fi

FINAL_NAME="trim-music-hub-${VERSION}${SUFFIX}.fpk"
FINAL_PATH="${OUT_DIR_ABS}/${FINAL_NAME}"
mv -f "${BUILT_FPK}" "${FINAL_PATH}"

(
  cd "${OUT_DIR_ABS}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${FINAL_NAME}" > "${FINAL_NAME}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${FINAL_NAME}" > "${FINAL_NAME}.sha256"
  fi
)

echo "✅ Built fnOS package: ${FINAL_PATH}"
if [ -f "${FINAL_PATH}.sha256" ]; then
  echo "🔒 SHA-256: $(cat "${FINAL_PATH}.sha256")"
fi
