# TRIM Music Hub - 后端 API 接口文档 (RESTful & SSE)

> **版本**：v2.0.2  
> **服务基础端口与入口**：生产环境 TCP `4175` / 独立开发环境 TCP `3175`（前端 Vite HMR `5175`）；同时可选监听飞牛统一网关 Unix Domain Socket（环境变量 `GATEWAY_SOCKET`，默认网关前缀 `GATEWAY_PREFIX=/app/trim-music-hub`）  
> **服务协议**：HTTP / Unix Domain Socket HTTP / SSE (Server-Sent Events)  
> **认证方式**：
> 1. **标准会话鉴权**：基于 HMAC-SHA256 签名的飞牛系统会话 Token（常量时间签名比对），支持通过 `HttpOnly` Cookie `fn_music_token=<token>`、请求头 `Authorization: Bearer <token>` 或 `X-Auth-Token: <token>` 传递（SSE `/api/stream` 额外支持 `?token=<token>`）。
> 2. **飞牛统一网关 SSO（仅限受信任 `GATEWAY_SOCKET` Unix Socket 通道）**：当请求经由飞牛 fnOS 桌面统一网关 Socket 转发时，服务端自动剥离 `GATEWAY_PREFIX` 子路径，并读取网关注入的 `X-Trim-Username`、`X-Trim-Userid`、`X-Trim-Isadmin` 请求头，结合 `music.db` `user` 表自动签发对应成员的 `fn_music_token` 会话 Cookie（普通 TCP 端口严格忽略此类请求头以防伪造）。  
> **多租户隔离**：所有接口默认按登录成员角色执行权限校验。管理员具备全量系统配置、公共曲库及多成员管理权限；普通成员严格隔离在本人创建的任务、队列、日志、历史记录、第三方绑定账号及专属歌单内。

---

## 目录
1. [系统与鉴权接口 (Auth & System)](#1-系统与鉴权接口-auth--system)
2. [实时状态与日志推流 (Status & SSE)](#2-实时状态与日志推流-status--sse)
3. [设置与目录管理 (Settings & Directories)](#3-设置与目录管理-settings--directories)
4. [全网检索与单曲下载 (Search & Download)](#4-全网检索与单曲下载-search--download)
5. [批量任务队列与控制 (Task Queue & Control)](#5-批量任务队列与控制-task-queue--control)
6. [飞牛歌单管理接口 (Playlists CRUD)](#6-飞牛歌单管理接口-playlists-crud)
7. [曲库检索与重复曲目治理 (Tracks & Duplicates)](#7-曲库检索与重复曲目治理-tracks--duplicates)
8. [导入历史记录接口 (History)](#8-导入历史记录接口-history)
9. [第三方音乐平台账号与日推同步 (Music Accounts)](#9-第三方音乐平台账号与日推同步-music-accounts)
10. [封面静态资源与兜底服务 (Covers Proxy)](#10-封面静态资源与兜底服务-covers-proxy)

---

## 1. 系统与鉴权接口 (Auth & System)

### 1.1 服务健康检查
- **接口**：`GET /api/health`
- **认证**：公开无需 Token
- **返回**：
  ```json
  {
    "ok": true,
    "status": "healthy",
    "timestamp": "2026-11-18T00:00:00.000Z"
  }
  ```

### 1.2 飞牛系统账号登录
- **接口**：`POST /api/auth/login`
- **认证**：公开无需 Token（内置单 IP 暴力破解限流：10 分钟内连续失败超过 10 次返回 `429 Too Many Requests`）
- **请求体 (JSON)**：
  ```json
  {
    "username": "admin",
    "password": "your_fnos_password"
  }
  ```
- **返回 (JSON)**（同时下发 `Set-Cookie: fn_music_token=...; HttpOnly; SameSite=Lax`）：
  ```json
  {
    "ok": true,
    "token": "eyJ1aWQiOjEwMDAsInVzZXJuYW1lIjoiYWRtaW4iLCJpc0FkbWluIjp0cnVlLCJleHAiOjE3MzI1MDAwMDB9.signature",
    "user": {
      "uid": 1000,
      "username": "admin",
      "isAdmin": true
    }
  }
  ```

### 1.3 校验当前登录会话
- **接口**：`GET /api/auth/me`
- **认证**：需要 Token（未登录或过期返回 `401`）
- **返回**：
  ```json
  {
    "ok": true,
    "authenticated": true,
    "user": {
      "uid": 1000,
      "username": "admin",
      "isAdmin": true
    }
  }
  ```

### 1.4 退出登录
- **接口**：`POST /api/auth/logout`
- **认证**：公开或已登录均可调用（清除 `fn_music_token` Cookie）
- **返回**：`{ "ok": true, "message": "已安全退出登录" }`

### 1.5 获取飞牛成员列表
- **接口**：`GET /api/users`
- **认证**：需要 Token（管理员返回全部飞牛成员；普通成员仅返回本人账号信息）
- **返回**：
  ```json
  {
    "ok": true,
    "data": [
      { "id": 1000, "name": "admin" }
    ]
  }
  ```

---

## 2. 实时状态与日志推流 (Status & SSE)

### 2.1 实时事件流 (Server-Sent Events)
- **接口**：`GET /api/stream`
- **认证**：需要 Token（Cookie、Header 或 `?token=...`）
- **多租户过滤**：普通成员仅接收本人所属任务的状态、进度与日志推流，不会泄露其他成员的任务详情。
- **推流消息类型 (`data` JSON 中的 `type` 字段)**：
  - `status`：全局/当前用户可见的任务状态快照
  - `track_update`：单首曲目状态增量更新（`index` + `track` + 汇总计数），避免大歌单全量数组重传
  - `queue`：经过当前用户权限过滤并脱敏后的任务队列列表
  - `log`：实时执行日志行
  - `logs_cleared`：日志清空通知

### 2.2 获取当前运行状态快照
- **接口**：`GET /api/status`
- **认证**：需要 Token
- **返回**：
  ```json
  {
    "ok": true,
    "isRunning": false,
    "data": {
      "status": "idle",
      "playlist_name": "",
      "total": 0,
      "reused_count": 0,
      "downloaded_count": 0,
      "failed_count": 0,
      "current_track": null,
      "tracks": []
    }
  }
  ```

### 2.3 获取运行日志
- **接口**：`GET /api/logs`
- **认证**：需要 Token（普通成员仅在当前任务归属本人时可见）
- **返回**：`{ "ok": true, "data": "[12:00:00] 任务启动...\n" }`

### 2.4 清空运行日志
- **接口**：`POST /api/logs/clear`
- **认证**：需要 Token（普通成员仅可清空本人运行日志）
- **返回**：`{ "ok": true }`

### 2.5 内部子进程状态上报（仅限本地受信任子进程）
- **接口**：`POST /api/update-status`
- **认证**：强制双重校验——仅允许 Loopback 本地回环地址（`127.0.0.1` / `::1`）且必须携带进程启动时注入的 `X-Internal-Token`（与 `INTERNAL_API_TOKEN` 常量时间比对），未授权访问直接返回 `403`。
- **请求体**：支持全量状态字段或增量字段 `track_update: { "index": 0, "track": { ... } }`。

---

## 3. 设置与目录管理 (Settings & Directories)

### 3.1 获取系统设置
- **接口**：`GET /api/settings`
- **认证**：需要 Token（非管理员自动脱敏隐藏 `custom_source.api_key` 等敏感字段）
- **返回**：
  ```json
  {
    "ok": true,
    "data": {
      "download_source": "kw",
      "download_dir": "/vol1/1000/Music",
      "is_configured": true,
      "concurrent_downloads": 5,
      "force_transcode": false,
      "transcode_quality": "320k",
      "available_sources": [
        { "id": "kw", "name": "酷我音乐", "desc": "高品质FLAC专线 · 推荐默认", "default": true },
        { "id": "kg", "name": "酷狗音乐", "desc": "海棠/星海SVIP线路", "default": false },
        { "id": "tx", "name": "QQ音乐", "desc": "长青/溯音专线", "default": false },
        { "id": "wy", "name": "网易云音乐", "desc": "163云音乐线路", "default": false },
        { "id": "auto", "name": "智能多源聚合", "desc": "酷我优先，故障自动回退", "default": false },
        { "id": "custom", "name": "自定义音源", "desc": "自建 API 端点 / 远程源脚本解析", "default": false }
      ],
      "custom_source": {
        "name": "自建音乐解析服务",
        "api_url": "",
        "api_key": "",
        "script_url": ""
      }
    }
  }
  ```

### 3.2 更新系统设置
- **接口**：`POST /api/settings`
- **认证**：仅限管理员（非管理员返回 `403`）
- **说明**：当存在运行中或排队中的任务时，禁止修改 `download_dir`（返回 `409`），其余参数（音源线路、并发数 `1~10`、转码开关与目标品质 `flac24bit | flac | 320k | 128k`）允许正常保存。

### 3.3 获取飞牛授权音乐目录列表
- **接口**：`GET /api/settings/directories`
- **认证**：仅限管理员
- **返回**：`{ "ok": true, "data": [{ "path": "/vol1/1000/Music", "name": "Music", "exists": true, "writable": true, "is_fnos_authorized": true, "file_count": 128 }] }`

### 3.4 校验自定义保存目录读写权限
- **接口**：`POST /api/settings/verify-directory`
- **认证**：仅限管理员
- **请求体**：`{ "path": "/vol1/1000/Music" }`
- **返回**：`{ "ok": true, "data": { "ok": true, "path": "/vol1/1000/Music", "exists": true, "writable": true, "is_fnos_authorized": true, "error": null } }`

---

## 4. 全网检索与单曲下载 (Search & Download)

### 4.1 全网音源检索与本地查重标记
- **接口**：`GET /api/search/online?q=晴天&page=1&page_size=20`
- **认证**：需要 Token
- **说明**：调用音源聚合搜索并通过 `db_ops.py batch_check`（stdin 管道传输）批量比对飞牛本地曲库（自动排除 `is_admin_deleted != 0` 的软删除记录）。
- **返回**：
  ```json
  {
    "ok": true,
    "page": 1,
    "page_size": 20,
    "total": 100,
    "has_more": true,
    "data": [
      {
        "id": "123456",
        "title": "晴天",
        "artist": "周杰伦",
        "album": "叶惠美",
        "duration": 269,
        "source": "kw",
        "qualities": ["flac24bit", "flac", "320k", "128k"],
        "max_quality": "flac24bit",
        "local_exists": true,
        "local_path": "/vol1/1000/Music/周杰伦 - 晴天.flac"
      }
    ]
  }
  ```

### 4.2 单曲下载入队
- **接口**：`POST /api/download/single`
- **认证**：需要 Token
- **请求体**：
  ```json
  {
    "artist": "周杰伦",
    "song": "晴天",
    "album": "叶惠美",
    "cover": "https://...",
    "quality": "flac24bit",
    "source": "kw",
    "force": false
  }
  ```
  - `quality` 支持：`flac24bit` | `flac` | `320k` | `128k`
  - `force`: 为 `true` 时强制重新下载并覆盖本地同名文件，同时自动复活历史被软删除的数据库记录
- **返回**：`{ "ok": true, "task_id": "task_...", "queued": false, "message": "已开始后台下载《晴天》" }`

---

## 5. 批量任务队列与控制 (Task Queue & Control)

> **安全持久化**：持久化至 `data/task_queue.json` 时自动剥离所有 `cookie` 凭据，重启后通过 `account_id` 动态还原。

### 5.1 解析外部歌单链接与本地查重预检
- **接口**：`POST /api/tasks/parse-playlist`
- **认证**：需要 Token
- **说明**：支持网易云音乐、QQ 音乐分享文本/链接及 `daily://<provider>/<account_id>` 虚拟协议。关联账号 Cookie 一律通过 `--cookie-stdin` 管道传入 Python 子进程，绝不暴露在宿主机 `ps` 命令行中。
- **请求体**：
  ```json
  {
    "url": "https://music.163.com/playlist?id=123456",
    "account_id": "acc_netease_admin"
  }
  ```

### 5.2 探测指定音源下歌单曲目的可用音质
- **接口**：`POST /api/tasks/query-source-qualities`
- **认证**：需要 Token
- **请求体**：
  ```json
  {
    "source": "kw",
    "tracks": [
      { "index": 0, "title": "晴天", "artist": "周杰伦", "exists": false }
    ]
  }
  ```
- **返回**：`{ "ok": true, "data": [{ "index": 0, "available_qualities": ["flac24bit", "flac", "320k", "128k"] }] }`

### 5.3 创建歌单同步入库任务
- **接口**：`POST /api/tasks/start`
- **认证**：需要 Token（非管理员创建任务时强制绑定为本人专属歌单 `target: "user"`）
- **请求体**：
  ```json
  {
    "url": "https://music.163.com/playlist?id=123456",
    "target": "user",
    "user": "admin",
    "playlist_name": "精选华语歌单",
    "quality": "flac",
    "source": "kw",
    "tracks": []
  }
  ```

### 5.4 获取任务队列列表
- **接口**：`GET /api/tasks/queue`
- **认证**：需要 Token（管理员可见全部队列，普通成员仅见本人任务）
- **返回**：`{ "ok": true, "isAdmin": true, "data": [...] }`

### 5.5 拖拽调整排队中任务的顺序
- **接口**：`POST /api/tasks/reorder`
- **认证**：需要 Token（普通成员仅可调整本人排队任务的相对顺序，不影响其他成员任务槽位）
- **请求体**：`{ "task_ids": ["task_1", "task_2"] }`

### 5.6 取消排队任务 / 终止并移除任务记录
- **接口**：`POST /api/tasks/cancel`
- **认证**：需要 Token（校验任务归属权；终止运行中任务时向整个子进程组 `-pid` 发送 `SIGTERM`）
- **请求体**：`{ "task_id": "task_1" }`

### 5.7 断点续传中断或失败的任务
- **接口**：`POST /api/tasks/resume`
- **认证**：需要 Token（校验任务归属权）
- **请求体**：`{ "task_id": "task_1" }`

### 5.8 清理所有已完成/已停止任务记录
- **接口**：`POST /api/tasks/clear-completed`
- **认证**：需要 Token（管理员清理全局已完成项；普通成员仅清理本人已完成项）

### 5.9 中止当前正在执行的任务
- **接口**：`POST /api/tasks/stop`
- **认证**：需要 Token（校验当前运行任务的归属权，向子进程组发送 `SIGTERM`）

---

## 6. 飞牛歌单管理接口 (Playlists CRUD)

> **ID 精确隔离与防误删保护**：所有歌单增删改查均支持 `playlist_id` / `playlist_ids` 精确主键定位，彻底杜绝不同成员同名私人歌单（如“我喜欢的音乐”）互相覆盖或越权访问；联动删除物理文件前自动调用 `get_unreferenced_track_ids` 排除仍被其他歌单引用的共享曲目。

### 6.1 获取可见歌单列表
- **接口**：`GET /api/playlists`
- **认证**：需要 Token（管理员返回全部歌单；普通成员仅返回公共歌单与本人专属歌单）
- **返回**：
  ```json
  {
    "ok": true,
    "data": [
      {
        "id": 12,
        "guid": "a1b2c3d4e5f600001111222233334444",
        "name": "我喜欢的音乐",
        "track_count": 45,
        "cover": "e5f6g7h8...",
        "is_public": false,
        "users": ["admin"],
        "user_ids": [1000],
        "playlist_ids": [12]
      }
    ]
  }
  ```

### 6.2 获取指定歌单曲目列表
- **接口**：`GET /api/playlists/tracks?name=我喜欢的音乐&playlist_id=12&playlist_ids=12`
- **认证**：需要 Token（校验当前成员对该歌单的读取权限）
- **返回**：`{ "ok": true, "data": [{ "id": 101, "title": "晴天", "artist": "周杰伦", "album": "叶惠美", "duration": 269, "file_type": "flac", "file_size": 28311552, "path": "/vol1/1000/Music/周杰伦 - 晴天.flac" }] }`

### 6.3 歌单重命名
- **接口**：`POST /api/playlists/rename`
- **认证**：需要 Token（管理员可重命名任意歌单；普通成员可重命名本人独享的个人歌单）
- **请求体**：
  ```json
  {
    "old_name": "原歌单名",
    "new_name": "新歌单名",
    "playlist_id": 12,
    "playlist_ids": [12]
  }
  ```

### 6.4 修改歌单可见范围与归属成员
- **接口**：`POST /api/playlists/update-users`
- **认证**：仅限管理员
- **请求体**：
  ```json
  {
    "name": "精选歌单",
    "user_ids": [1000],
    "playlist_id": 12,
    "playlist_ids": [12]
  }
  ```
  - `user_ids` 为空数组 `[]` 时转为全员可见的公共歌单。

### 6.5 从歌单中批量移除曲目
- **接口**：`POST /api/playlists/remove-tracks`
- **认证**：需要 Token（管理员可操作任意歌单；普通成员可从本人个人歌单移除曲目，但仅管理员允许传 `remove_physical: true` 删除底层物理文件）
- **请求体**：
  ```json
  {
    "name": "我喜欢的音乐",
    "track_ids": [101, 102],
    "remove_physical": false,
    "playlist_id": 12,
    "playlist_ids": [12]
  }
  ```

### 6.6 删除歌单
- **接口**：`POST /api/playlists/delete`
- **认证**：需要 Token（普通成员仅可删除本人个人歌单，且强制 `delete_tracks: false` 以保护共享底层曲库；管理员传 `delete_tracks: true` 时仅物理删除未被其他任何活跃歌单引用的曲目）
- **请求体**：
  ```json
  {
    "name": "我喜欢的音乐",
    "delete_tracks": false,
    "playlist_id": 12,
    "playlist_ids": [12]
  }
  ```

---

## 7. 曲库检索与重复曲目治理 (Tracks & Duplicates)

### 7.1 本地曲库搜索与分页浏览
- **接口**：`GET /api/tracks/search?q=周杰伦&page=1&limit=50`
- **认证**：需要 Token
- **说明**：底层按 `t.id` 去重分页并聚合多歌手名称（`GROUP_CONCAT(DISTINCT ar.name)`），避免合唱曲目导致分页总数偏移或重复行。
- **返回**：
  ```json
  {
    "ok": true,
    "data": {
      "total": 120,
      "page": 1,
      "limit": 50,
      "list": [
        {
          "id": 101,
          "guid": "...",
          "title": "珊瑚海",
          "artist": "周杰伦 / 梁心颐",
          "album": "十一月的萧邦",
          "duration": 256,
          "file_type": "flac",
          "file_size": 29412000,
          "bitrate": 920,
          "path": "/vol1/1000/Music/周杰伦 - 珊瑚海.flac"
        }
      ]
    }
  }
  ```

### 7.2 扫描曲库重复版本
- **接口**：`GET /api/tracks/duplicates?q=`
- **认证**：需要 Token
- **返回**：按标准化歌名+主歌手聚类，自动选出最高音质建议保留项（`recommended_keep_id`）并统计可释放空间（`reclaimable_size`）。

### 7.3 删除单首曲目
- **接口**：`POST /api/tracks/delete`
- **认证**：仅限管理员
- **请求体**：`{ "track_id": 101, "remove_physical": true }`

### 7.4 批量删除曲目
- **接口**：`POST /api/tracks/batch-delete`
- **认证**：仅限管理员（底层通过 stdin JSON 数组传入 `db_ops.py`，支持大批量曲目一次事务清理，同时校验音频文件路径必须位于受控媒体目录内）
- **请求体**：`{ "track_ids": [204, 305], "remove_physical": true }`

---

## 8. 导入历史记录接口 (History)

### 8.1 获取导入历史列表
- **接口**：`GET /api/history`
- **认证**：需要 Token（管理员可见全部历史；普通成员仅见公共任务与本人发起的历史记录）
- **返回**：`{ "ok": true, "data": [...] }`

### 8.2 删除单条历史记录
- **接口**：`POST /api/history/delete`
- **认证**：需要 Token（校验记录归属权）
- **请求体**：`{ "id": 1730000000000 }`

### 8.3 清空历史记录
- **接口**：`POST /api/history/clear`
- **认证**：需要 Token（管理员清空全部历史；普通成员仅清空本人专属历史记录）

---

## 9. 第三方音乐平台账号与日推同步 (Music Accounts)

### 9.1 网易云音乐：生成扫码登录二维码
- **接口**：`POST /api/music-accounts/netease/qr/create`
- **认证**：需要 Token
- **返回**：`{ "ok": true, "unikey": "...", "qr_url": "https://music.163.com/login?codekey=...", "qr_img": "data:image/png;base64,..." }`

### 9.2 网易云音乐：轮询扫码授权状态
- **接口**：`POST /api/music-accounts/netease/qr/check`
- **认证**：需要 Token
- **请求体**：`{ "unikey": "..." }`
- **返回**：`status` 为 `waiting` | `scanned` | `expired` | `success`（授权成功后自动加密保存至 `data/music_accounts.json` 并绑定至当前登录成员）。

### 9.3 获取已绑定与可连接的音乐平台账号
- **接口**：`GET /api/music-accounts`
- **认证**：需要 Token（管理员可见全员绑定账号；普通成员仅见本人绑定账号及未连接平台入口）

### 9.4 通过 Cookie 绑定第三方音乐账号
- **接口**：`POST /api/music-accounts/:target`
- **认证**：需要 Token（Cookie 通过 `--cookie-stdin` 安全校验会话有效性）
- **请求体**：`{ "cookie": "MUSIC_U=..." }`

### 9.5 解绑并销毁第三方音乐账号凭据
- **接口**：`DELETE /api/music-accounts/:target`
- **认证**：需要 Token（仅账号归属人或管理员可操作）

### 9.6 获取第三方账号云端歌单列表
- **接口**：`GET /api/music-accounts/:target/playlists`
- **认证**：需要 Token（仅账号归属人或管理员可访问）

### 9.7 一键导入第三方账号歌单
- **接口**：`POST /api/music-accounts/:target/import`
- **认证**：需要 Token（仅账号归属人或管理员可访问）
- **请求体**：`{ "urls": ["https://..."], "target": "user", "user": "admin", "quality": "flac" }`

### 9.8 预览今日个性化推荐歌曲与本地查重
- **接口**：`GET /api/music-accounts/:target/daily-recommend`
- **认证**：需要 Token（仅账号归属人或管理员可访问）

### 9.9 立即触发今日推荐后台同步任务
- **接口**：`POST /api/music-accounts/:target/daily-sync`
- **认证**：需要 Token（仅账号归属人或管理员可访问）

### 9.10 更新每日推荐自动同步配置
- **接口**：`POST /api/music-accounts/:target/settings`
- **认证**：需要 Token（仅账号归属人或管理员可访问；非管理员 `daily_sync_target` 强制锁定为 `"user"`）
- **请求体**：
  ```json
  {
    "daily_sync_enabled": true,
    "daily_sync_time": "04:00",
    "daily_sync_target": "user",
    "daily_sync_user": "admin",
    "daily_sync_quality": "flac24bit",
    "daily_sync_playlist_name": "每日推荐"
  }
  ```

---

## 10. 封面静态资源与兜底服务 (Covers Proxy)

### 10.1 读取歌单/曲目/专辑/歌手封面
- **接口**：`GET /api/covers/:type/:guid?size=160`
- **认证**：需要有效会话 Cookie 或 Token
- **参数说明**：
  - `:type`：`playlist` | `track` | `album` | `artist`
  - `:guid`：32 位十六进制标识
  - `size`：可选尺寸（默认 `160`）
- **查找链路**：
  1. 优先读取飞牛官方封面目录（`FNOS_COVER_DIR`）；
  2. 当官方目录只读或尚未索引时，自动回退读取持久化目录 `DATA_DIR/covers` 下的同步封面缓存；
  3. 仍未命中且为 `track` / `album` 时，尝试从本地音频文件内嵌封面动态提取。
- **返回**：二进制图片流（`image/jpeg` / `image/png` / `image/webp`，附带 `Cache-Control: public, max-age=86400`）。
