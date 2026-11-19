# TRIM Music Hub — 飞牛 fnOS (`.fpk`) 应用打包指南

本目录提供符合飞牛 `fnpack 1.2.x` 官方规范的 **Route A 全功能原生级 `.fpk` 打包体系**，完整保留直通「飞牛音乐 (`trim.music`)」曲库与歌单同步、飞牛桌面统一网关免密单点登录（SSO）以及多音源无损下载能力。

---

## ✨ 安装包特性

1. **飞牛桌面图标与免密单点登录 (Unified Gateway SSO)**
   - 注册飞牛桌面窗口入口 `trim-music-hub.main`，通过 Unix Domain Socket (`/var/apps/trim-music-hub/target/trim-music-hub.sock`) 接入飞牛统一网关 `/app/trim-music-hub/`。
   - 自动识别当前登录飞牛桌面的成员账号与管理员角色（`X-Trim-Username` / `X-Trim-Userid` / `X-Trim-Isadmin`），无需二次输入密码即可进入对应成员空间；同时完美兼容飞牛 FN Connect 远程访问与 HTTPS。
2. **双入口并行访问**
   - 除飞牛桌面窗口外，仍保留局域网直连端口（默认 `4175`，可在安装或设置向导中随时调整），兼容外部浏览器与自定义 Nginx 反向代理。
3. **跨存储卷自动探测 (`trim.music`)**
   - 自动探测 `/vol1`、`/vol2` 等任意存储卷上的 `trim.music` 数据库目录、封面缓存目录以及 `shared_library` 中授权的所有音乐目录，并以**宿主机同路径**挂载进容器，确保数据库记录路径与 `.m3u8` 播放列表路径 100% 一致。
4. **卸载零误伤保护**
   - 卸载向导支持选择「保留应用配置与绑定账号」或「清理应用配置缓存」，无论选择哪一项，**均绝不触碰任何本地音乐音频文件与已同步的飞牛歌单**。

---

## 📦 三种打包模式说明

`./packaging/fpk/build.sh` 支持三种构建模式，满足不同分发场景：

| 模式 (`--mode`) | 适用架构 (`platform`) | 产物体积 | 特点与适用场景 |
| :--- | :--- | :--- | :--- |
| **`bundle`**（推荐分发） | `x86` (`amd64`) 或 `arm` (`arm64`) | ~120–180 MB | **100% 纯离线安装包**，内置压缩后的运行镜像，NAS 无需联网拉取镜像或现场编译，秒级安装启动 |
| **`online`** | `all`（全架构通用） | ~430 KB | 优先拉取预构建多架构镜像（如 GHCR），若拉取受阻自动回退本地 `Dockerfile` 编译 |
| **`source`**（默认本地） | `all`（全架构通用） | ~430 KB | 内置纯净工程源码与 `Dockerfile`，无需外部镜像仓库，首次安装时在 NAS 本地完成镜像构建 |

---

## 🛠️ 本地一键打包命令

脚本会自动检测系统 `fnpack` 命令；若未安装，将自动下载飞牛官方 `fnpack 1.2.3` 至 `.tools/fnpack`（已加入 `.gitignore`）。

### 1. 构建通用源码版 `.fpk`（最快，无需本地 Docker Buildx）
```bash
./packaging/fpk/build.sh --mode source
# 产物：dist/trim-music-hub-2.0.2.fpk
```

### 2. 构建纯离线内置镜像版 `.fpk`（x86_64 / ARM64）
```bash
# 构建飞牛 x86_64 离线安装包
./packaging/fpk/build.sh --mode bundle --arch amd64

# 构建飞牛 ARM64 离线安装包
./packaging/fpk/build.sh --mode bundle --arch arm64
```

### 3. 构建在线镜像 + 源码兜底混合版 `.fpk`
```bash
./packaging/fpk/build.sh \
  --mode online \
  --image ghcr.io/your-org/trim-music-hub:2.0.2
```

### 4. 重新生成高清圆角应用图标（可选）
```bash
python3 ./packaging/fpk/generate_icons.py
```

---

## 🚀 GitHub Actions 自动构建与发布

仓库已内置 [`.github/workflows/release-fpk.yml`](../../.github/workflows/release-fpk.yml)：
- **推送版本标签自动发版**：
  ```bash
  git tag v2.0.2
  git push origin v2.0.2
  ```
  自动构建并推送 `linux/amd64` + `linux/arm64` 多架构镜像至 GHCR，同时打包生成 `amd64` 离线版、`arm64` 离线版、`online` 轻量通用版与通用源码版共 4 个 `.fpk` 及其 `.sha256` 校验文件，自动挂载至 GitHub Releases。
- **手动触发构建**：在 GitHub 仓库 **Actions -> Build & Release fnOS FPK -> Run workflow** 点击运行，即可在 Workflow Artifacts 中直接下载全套 `.fpk` 安装包。

---

## 🖥️ 在飞牛 fnOS 中手动安装步骤

1. 确保已在飞牛「应用中心」安装并打开过一次官方 **「飞牛音乐」**（完成媒体库目录添加）。
2. 确保已在飞牛「应用中心」安装并启用 **「Docker」**。
3. 打开飞牛 **「应用中心」** -> 点击左下角或右上角 **「手动安装」** -> 上传对应架构的 `.fpk` 文件（x86 设备优先推荐 `-amd64.fpk`）。
4. 按安装向导确认服务端口（默认 `4175`）、默认下载目录（默认 `auto` 自动继承飞牛音乐媒体库）与默认音源后点击完成。
5. 安装完成后，直接点击飞牛桌面上的 **「TRIM Music Hub」** 图标即可免密进入。
