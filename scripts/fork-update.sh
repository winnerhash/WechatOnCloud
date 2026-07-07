#!/usr/bin/env bash
# Fork 更新脚本：在临时容器中由面板触发执行。
# 流程：git fetch upstream → merge → docker build 面板镜像 → docker compose up -d panel
#
# 所需挂载：
#   - /var/run/docker.sock:/var/run/docker.sock（Docker 访问）
#   - /home/rogerwi/woc:/home/rogerwi/woc（仓库目录，宿主原路径挂载）
#
# 环境变量：
#   WOC_REPO_PATH  — 仓库在宿主上的路径（默认 /home/rogerwi/woc）
#   WOC_UPDATER_SPEC — JSON，含 panelName（目前仅用于日志）
#
# 退出码：0=成功  2=合并冲突  3=构建失败  4=启动失败  1=其他错误
set -euo pipefail

REPO="${WOC_REPO_PATH:-/home/rogerwi/woc}"
SPEC="${WOC_UPDATER_SPEC:-{}}"
PANEL_NAME=$(echo "$SPEC" | jq -r '.panelName // "woc-panel"')

log()  { echo "[fork-update] $(date '+%H:%M:%S') $*"; }
err()  { echo "[fork-update] $(date '+%H:%M:%S') ERROR: $*" >&2; }

# 等面板把 HTTP 响应回给前端
sleep 3

# ---- Step 1: Fetch upstream ----
cd "$REPO"
# helper 容器以 root 运行、仓库属主是宿主用户 → git 报 dubious ownership，需放行
git config --global --add safe.directory "$REPO"
log "Fetching upstream..."
git fetch upstream 2>&1 || { err "git fetch upstream failed"; exit 1; }

# ---- Step 2: Merge upstream/main ----
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse upstream/main 2>/dev/null) || { err "cannot resolve upstream/main"; exit 1; }

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Already up to date with upstream/main"
  # 没有新代码可合并，但仍重建面板（可能 .env 或构建参数变了）
else
  log "New upstream commits found, merging..."
  if git merge upstream/main --ff-only 2>&1; then
    log "Fast-forward merge successful"
  elif git merge upstream/main --no-edit 2>&1; then
    log "Merge commit successful"
  else
    err "Merge conflict detected — automatic update aborted"
    git merge --abort 2>/dev/null || true
    exit 2
  fi
fi

# ---- Step 3: Build panel image ----
UPSTREAM_VER=$(git describe --tags --abbrev=0 upstream/main 2>/dev/null || echo "unknown")
FORK_SHA=$(git rev-parse --short HEAD)
VER="${UPSTREAM_VER}-fork+${FORK_SHA}"
TARGET_IMAGE="winnerhash/woc-panel:latest"

log "Building panel image (version: ${VER})..."
if ! docker build \
  --provenance=false --sbom=false \
  --build-arg "WOC_VERSION=${VER}" \
  -t "${TARGET_IMAGE}" \
  "${REPO}/panel" 2>&1; then
  err "Docker build failed"
  exit 3
fi
log "Image built: ${TARGET_IMAGE}"

# ---- Step 4: Recreate panel via docker compose ----
log "Recreating panel container..."
cd "$REPO"
if ! docker compose up -d panel 2>&1; then
  err "docker compose up -d panel failed"
  exit 4
fi

# ---- Step 5: Verify ----
sleep 5
if docker ps --filter "name=${PANEL_NAME}" --filter "status=running" --format '{{.Names}}' | grep -q "${PANEL_NAME}"; then
  log "Panel is running — update complete (version: ${VER})"

  # ---- Step 6: Push merged result to fork remote (best-effort，不阻断已成功的部署) ----
  log "Pushing merged result to myfork woc/audio-notify..."
  # 从宿主 /etc/environment 提取 token（cut 去 key=，tr 清掉所有空白——/etc/environment 里值可能带前导空格/\r）
  GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' /etc/environment 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
  if [ -n "$GITHUB_TOKEN" ]; then
    if git -c "credential.helper=!f(){ echo username=winnerhash; echo password=$GITHUB_TOKEN; }; f" push myfork HEAD:woc/audio-notify 2>&1; then
      log "Pushed to myfork woc/audio-notify"
    else
      err "git push myfork failed — deployment already succeeded, push skipped"
    fi
  else
    err "GITHUB_TOKEN missing in /etc/environment — skipped push (deployment succeeded)"
  fi
  exit 0
else
  err "Panel failed to start after update"
  exit 4
fi
