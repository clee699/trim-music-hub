#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TRIM Music Hub - fnOS SQLite Database Bridge
Connects to fnOS music.db to provide:
1. Fast local library deduplication (exact and fuzzy title/artist matches)
2. Playlist CRUD (ID-isolated & multi-tenant safe list, rename, delete, track listing)
3. Local track management & safe physical file deletion
4. fnOS user resolution & OTA schema introspection
"""

import os
import sys
import json
import sqlite3
import shutil
import re
import uuid
import datetime
import hashlib

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR") or os.path.join(PROJECT_DIR, "data"))
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
PLAYLIST_GROUPS_FILE = os.path.join(DATA_DIR, "playlist_groups.json")

DEFAULT_DB = "/app/db/music.db" if os.path.exists("/app/db/music.db") else "/usr/local/apps/@appdata/trim.music/db/music.db"
DB_PATH = os.environ.get("FNOS_DB_PATH", DEFAULT_DB)

DEFAULT_MUSIC = "/media/music" if os.path.exists("/media/music") else "/vol1/1000/Music"
AUDIO_EXTS = (".flac", ".mp3", ".alac", ".wav", ".m4a", ".aac", ".ogg")
TZ_CN = datetime.timezone(datetime.timedelta(hours=8))


def now_cn_str() -> str:
    return datetime.datetime.now(TZ_CN).strftime("%Y-%m-%d %H:%M:%S.000000000+08:00")


def load_effective_music_dir() -> str:
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                d = (data.get("download_dir") or "").strip()
                if d and os.path.exists(d):
                    return d
        except Exception:
            pass
    return os.environ.get("MUSIC_DIR", DEFAULT_MUSIC)


MUSIC_ROOT = load_effective_music_dir()
PLAYLIST_DIR = os.path.join(MUSIC_ROOT, "歌单")


def sanitize_playlist_filename(name: str) -> str:
    if not name:
        return "未命名歌单"
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name)).strip()
    cleaned = cleaned.replace("..", "_").strip(". ")
    return cleaned or "未命名歌单"


def resolve_safe_m3u_path(name: str, ext: str = ".m3u8") -> str:
    safe_name = sanitize_playlist_filename(name)
    base_real = os.path.realpath(PLAYLIST_DIR)
    candidate = os.path.realpath(os.path.join(PLAYLIST_DIR, f"{safe_name}{ext}"))
    if os.path.commonpath([base_real, candidate]) != base_real or candidate == base_real:
        raise ValueError("非法的歌单文件名称")
    return candidate


def _sub_cursor(cursor_or_conn):
    if hasattr(cursor_or_conn, "cursor"):
        return cursor_or_conn.cursor()
    if hasattr(cursor_or_conn, "connection"):
        return cursor_or_conn.connection.cursor()
    return cursor_or_conn


def get_allowed_audio_roots(cursor=None) -> list:
    roots = set()
    for base in [MUSIC_ROOT, os.environ.get("MUSIC_DIR", ""), DEFAULT_MUSIC]:
        if base:
            roots.add(os.path.realpath(base))
    if cursor is not None:
        try:
            sub = _sub_cursor(cursor)
            if table_exists(sub, "shared_library"):
                sub.execute("SELECT path FROM shared_library WHERE path IS NOT NULL")
                for row in sub.fetchall():
                    p = row["path"] if isinstance(row, sqlite3.Row) else row[0]
                    if p:
                        roots.add(os.path.realpath(p))
        except Exception:
            pass
    return list(roots)


def is_safe_audio_file_path(file_path: str, allowed_roots: list) -> bool:
    if not file_path:
        return False
    try:
        real_p = os.path.realpath(file_path)
        for root in allowed_roots:
            if not root:
                continue
            try:
                if os.path.commonpath([root, real_p]) == root and real_p != root:
                    return True
            except ValueError:
                continue
    except Exception:
        return False
    return False


def get_db(required=True):
    try:
        if not os.path.exists(DB_PATH):
            if required:
                raise FileNotFoundError(
                    f"fnOS database not found at {DB_PATH}. Please verify volume mapping or check permissions."
                )
            return None
        conn = sqlite3.connect(DB_PATH, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout = 30000")
        except Exception:
            pass
        return conn
    except Exception:
        if required:
            raise
        return None


# ==================== 动态表结构自省与 OTA 升级兼容保护层 ====================
_TABLE_COLUMNS_CACHE = {}


def get_table_columns(cursor_or_conn, table_name: str) -> dict:
    """
    通过 PRAGMA table_info(table_name) 动态自省获取目标表真实列结构。
    """
    if table_name in _TABLE_COLUMNS_CACHE:
        return _TABLE_COLUMNS_CACHE[table_name]

    if not re.match(r"^[A-Za-z0-9_]+$", table_name or ""):
        return {}

    cols = {}
    try:
        cursor = _sub_cursor(cursor_or_conn)
        cursor.execute(f'PRAGMA table_info("{table_name}");')
        for r in cursor.fetchall():
            c_name = r["name"] if isinstance(r, sqlite3.Row) else r[1]
            c_type = (r["type"] if isinstance(r, sqlite3.Row) else r[2]) or ""
            c_notnull = bool(r["notnull"] if isinstance(r, sqlite3.Row) else r[3])
            c_dflt = r["dflt_value"] if isinstance(r, sqlite3.Row) else r[4]
            c_pk = bool(r["pk"] if isinstance(r, sqlite3.Row) else r[5])
            cols[c_name] = {
                "name": c_name,
                "type": c_type.upper(),
                "notnull": c_notnull,
                "dflt_value": c_dflt,
                "pk": c_pk,
            }
        if cols:
            _TABLE_COLUMNS_CACHE[table_name] = cols
    except Exception:
        pass
    return cols


def table_exists(cursor_or_conn, table_name: str) -> bool:
    """检测目标数据表在当前数据库中是否存在。"""
    try:
        cursor = _sub_cursor(cursor_or_conn)
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?;", (table_name,))
        return cursor.fetchone() is not None
    except Exception:
        return False


def check_schema_compatibility(cursor_or_conn=None) -> dict:
    """
    对飞牛音乐数据库执行结构完整性（核心表 + 核心外键列）与版本指纹自检。
    若检测到飞牛 OTA 大版本重构导致核心表或关键列缺失，返回 safe_mode = True。
    """
    close_when_done = False
    conn = None
    if cursor_or_conn is None:
        conn = get_db(required=False)
        if not conn:
            return {
                "compatible": False,
                "safe_mode": True,
                "schema_fingerprint": "",
                "tables_found": [],
                "missing_tables": ["all"],
                "reason": "无法连接或未配置飞牛音乐数据库 (music.db)",
            }
        cursor = conn.cursor()
        close_when_done = True
    else:
        cursor = cursor_or_conn.cursor() if hasattr(cursor_or_conn, "cursor") else cursor_or_conn

    try:
        required_schema = {
            "track": ["id", "audio_file_id", "title"],
            "playlist": ["id", "name", "user_id"],
            "playlist_track": ["playlist_id", "track_id"],
            "user": ["id", "name"],
            "audio_file": ["id", "path"],
        }
        found = []
        missing = []
        missing_columns = {}

        for tbl, req_cols in required_schema.items():
            if table_exists(cursor, tbl):
                found.append(tbl)
                actual_cols = get_table_columns(cursor, tbl)
                absent = [col for col in req_cols if col not in actual_cols]
                if absent:
                    missing_columns[tbl] = absent
            else:
                missing.append(tbl)

        cursor.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?, ?, ?) ORDER BY name;",
            ("track", "playlist", "playlist_track", "user", "audio_file"),
        )
        rows = cursor.fetchall()
        raw_ddl = "".join([f"{r[0]}:{r[1] or ''};" for r in rows])
        fingerprint = hashlib.sha256(raw_ddl.encode("utf-8")).hexdigest()[:16] if raw_ddl else ""

        if missing:
            return {
                "compatible": False,
                "safe_mode": True,
                "schema_fingerprint": fingerprint,
                "tables_found": found,
                "missing_tables": missing,
                "reason": f"检测到关键表缺失 ({', '.join(missing)})，已自动进入安全防损模式 (Safe Mode)",
            }

        if missing_columns:
            detail = ", ".join(f"{t}.{c}" for t, cols in missing_columns.items() for c in cols)
            return {
                "compatible": False,
                "safe_mode": True,
                "schema_fingerprint": fingerprint,
                "tables_found": found,
                "missing_tables": [],
                "missing_columns": missing_columns,
                "reason": f"检测到核心字段变更 ({detail})，已自动进入安全防损模式 (Safe Mode)",
            }

        return {
            "compatible": True,
            "safe_mode": False,
            "schema_fingerprint": fingerprint,
            "tables_found": found,
            "missing_tables": [],
            "reason": "结构完全兼容",
        }
    except Exception as e:
        return {
            "compatible": False,
            "safe_mode": True,
            "schema_fingerprint": "",
            "tables_found": [],
            "missing_tables": ["error"],
            "reason": f"数据库结构自省异常: {e}",
        }
    finally:
        if close_when_done and conn:
            try:
                conn.close()
            except Exception:
                pass


def safe_insert(cursor, table_name: str, data: dict, or_ignore: bool = False) -> int:
    """
    基于动态列自省 (PRAGMA table_info) 执行安全的 INSERT。
    """
    cols = get_table_columns(cursor, table_name)
    if not cols:
        raise ValueError(f"Target table '{table_name}' does not exist or has no accessible schema.")

    filtered_data = {k: v for k, v in data.items() if k in cols}

    now_str = now_cn_str()
    for col_name, meta in cols.items():
        if meta["notnull"] and not meta["pk"] and meta["dflt_value"] is None and col_name not in filtered_data:
            c_type = meta["type"]
            if any(t in c_type for t in ["INT", "BOOL", "NUMERIC", "REAL", "FLOAT"]):
                filtered_data[col_name] = 0
            elif "TIME" in c_type or "DATE" in c_type or col_name.endswith("_at"):
                filtered_data[col_name] = now_str
            elif "guid" in col_name.lower():
                filtered_data[col_name] = uuid.uuid4().hex
            else:
                filtered_data[col_name] = ""

    if not filtered_data:
        raise ValueError(f"No valid columns matched for table '{table_name}'.")

    col_names = list(filtered_data.keys())
    placeholders = ", ".join(["?"] * len(col_names))
    quoted_cols = ", ".join([f'"{c}"' for c in col_names])
    verb = "INSERT OR IGNORE INTO" if or_ignore else "INSERT INTO"
    sql = f'{verb} "{table_name}" ({quoted_cols}) VALUES ({placeholders});'

    cursor.execute(sql, [filtered_data[c] for c in col_names])
    return cursor.lastrowid


def safe_update(cursor, table_name: str, data: dict, where_clause: str, where_params: list = None) -> int:
    """
    基于动态列自省执行安全的 UPDATE。
    """
    cols = get_table_columns(cursor, table_name)
    if not cols:
        return 0

    filtered_data = {k: v for k, v in data.items() if k in cols}
    if not filtered_data:
        return 0

    set_clause = ", ".join([f'"{k}" = ?' for k in filtered_data.keys()])
    sql = f'UPDATE "{table_name}" SET {set_clause} WHERE {where_clause};'
    params = list(filtered_data.values()) + (list(where_params) if where_params else [])
    cursor.execute(sql, params)
    return cursor.rowcount


def safe_mark_tracks_deleted(cursor, track_ids: list) -> int:
    """安全地将指定曲目 ID 列表标记为软删除，自适应字段变更。"""
    if not track_ids:
        return 0
    cols = get_table_columns(cursor, "track")
    update_data = {}
    if "is_admin_deleted" in cols:
        update_data["is_admin_deleted"] = 1
    if "is_audio_file_deleted" in cols:
        update_data["is_audio_file_deleted"] = 1
    if "updated_at" in cols:
        update_data["updated_at"] = now_cn_str()
    if not update_data:
        return 0
    placeholders = ",".join(["?"] * len(track_ids))
    return safe_update(cursor, "track", update_data, f"id IN ({placeholders})", track_ids)


def get_unreferenced_track_ids(cursor, candidate_track_ids: list) -> list:
    """
    过滤出不再被任何剩余歌单 (playlist_track) 引用的曲目 ID，防止删除歌单或移除曲目时误删其他歌单共享的歌曲。
    """
    ids = [int(tid) for tid in dict.fromkeys(candidate_track_ids) if tid is not None]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    cursor.execute(
        f"""
        SELECT t.id
        FROM track t
        WHERE t.id IN ({placeholders})
          AND NOT EXISTS (
              SELECT 1 FROM playlist_track pt
              JOIN playlist p ON pt.playlist_id = p.id
              WHERE pt.track_id = t.id
          )
        """,
        ids,
    )
    return [row["id"] if isinstance(row, sqlite3.Row) else row[0] for row in cursor.fetchall()]


def get_physically_deletable_paths(cursor, track_ids):
    """Return file paths not referenced by any active track outside track_ids."""
    ids = [int(tid) for tid in dict.fromkeys(track_ids) if tid is not None]
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    cursor.execute(
        f"""
        SELECT DISTINCT af.path
        FROM track selected
        JOIN audio_file af ON selected.audio_file_id = af.id
        WHERE selected.id IN ({placeholders})
          AND af.path IS NOT NULL
          AND TRIM(af.path) != ''
          AND NOT EXISTS (
              SELECT 1
              FROM track survivor
              LEFT JOIN audio_file survivor_af ON survivor.audio_file_id = survivor_af.id
              WHERE survivor.id NOT IN ({placeholders})
                AND survivor.is_admin_deleted = 0
                AND survivor.is_audio_file_deleted = 0
                AND (
                    survivor.audio_file_id = selected.audio_file_id
                    OR survivor_af.path = af.path
                )
          )
        """,
        ids + ids,
    )
    rows = cursor.fetchall()
    allowed_roots = get_allowed_audio_roots(cursor)
    paths = []
    for row in rows:
        p = row["path"] if isinstance(row, sqlite3.Row) else row[0]
        if p and is_safe_audio_file_path(p, allowed_roots):
            paths.append(p)
    return paths


def _remove_audio_and_sidecars(file_path: str, allowed_roots: list) -> bool:
    if not file_path or not is_safe_audio_file_path(file_path, allowed_roots):
        return False
    if not os.path.exists(file_path):
        return False
    try:
        os.remove(file_path)
        lrc_p = os.path.splitext(file_path)[0] + ".lrc"
        if os.path.exists(lrc_p) and is_safe_audio_file_path(lrc_p, allowed_roots):
            try:
                os.remove(lrc_p)
            except Exception:
                pass
        parent = os.path.dirname(file_path)
        if os.path.isdir(parent) and is_safe_audio_file_path(parent, allowed_roots) and not os.listdir(parent):
            os.rmdir(parent)
            grandparent = os.path.dirname(parent)
            if os.path.isdir(grandparent) and is_safe_audio_file_path(grandparent, allowed_roots) and not os.listdir(grandparent):
                os.rmdir(grandparent)
        return True
    except Exception:
        return False


# ==================== 歌单分组与多用户隔离层 ====================
def _load_playlist_group_registry() -> list:
    if not os.path.exists(PLAYLIST_GROUPS_FILE):
        return []
    try:
        with open(PLAYLIST_GROUPS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def register_playlist_group(playlist_ids: list, is_public: bool = False):
    clean_ids = sorted({int(pid) for pid in (playlist_ids or []) if str(pid).isdigit() or isinstance(pid, int)})
    if not clean_ids:
        return
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        groups = _load_playlist_group_registry()
        overlap_set = set(clean_ids)
        remaining = [g for g in groups if not overlap_set.intersection(set(g.get("playlist_ids") or []))]
        if len(clean_ids) > 1 or is_public:
            remaining.append({
                "playlist_ids": clean_ids,
                "is_public": bool(is_public),
                "updated_at": now_cn_str(),
            })
        with open(PLAYLIST_GROUPS_FILE, "w", encoding="utf-8") as f:
            json.dump(remaining, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _build_logical_playlists(cursor) -> list:
    """
    构建按真实归属隔离的逻辑歌单列表：
    - 仅当多行歌单属于显式注册的共享/公共组，或具有完全一致的名称 + 相同非空封面 GUID / 同批次创建时间戳 + 一致曲目集合时，才聚合为共享/公共歌单；
    - 不同成员各自独立创建的同名个人歌单（如各自导入的“我喜欢的音乐”）严格保持独立 ID，绝不跨用户混排或误删。
    """
    cursor.execute("SELECT id FROM user WHERE status = 'active'")
    active_uids = {int(r[0]) for r in cursor.fetchall()}

    cursor.execute(
        """
        SELECT p.id, p.guid, p.name, p.cover_guid, p.user_id, p.created_at,
               u.name AS user_name
        FROM playlist p
        LEFT JOIN user u ON p.user_id = u.id
        ORDER BY p.id ASC
        """
    )
    p_rows = cursor.fetchall()
    if not p_rows:
        return []

    cursor.execute(
        """
        SELECT pt.playlist_id, pt.track_id
        FROM playlist_track pt
        JOIN track t ON pt.track_id = t.id
        WHERE t.is_audio_file_deleted = 0 AND t.is_admin_deleted = 0
        """
    )
    tracks_by_pid = {}
    for r in cursor.fetchall():
        pid = int(r[0])
        tid = int(r[1])
        tracks_by_pid.setdefault(pid, set()).add(tid)

    registry = _load_playlist_group_registry()
    pid_to_reg_idx = {}
    reg_public = {}
    for idx, grp in enumerate(registry):
        g_ids = [int(x) for x in (grp.get("playlist_ids") or []) if isinstance(x, int) or str(x).isdigit()]
        if g_ids:
            for pid in g_ids:
                pid_to_reg_idx[pid] = idx
            reg_public[idx] = bool(grp.get("is_public"))

    buckets = {}
    for r in p_rows:
        pid = int(r["id"])
        name = r["name"] or ""
        cover_guid = (r["cover_guid"] or "").strip()
        created_sec = str(r["created_at"] or "")[:19]
        tset = frozenset(tracks_by_pid.get(pid, set()))

        if pid in pid_to_reg_idx:
            gkey = ("reg", pid_to_reg_idx[pid], name)
        elif cover_guid:
            gkey = ("cov", name, cover_guid, tset)
        elif created_sec and len(tset) > 0:
            gkey = ("batch", name, created_sec, tset)
        else:
            gkey = ("single", pid)

        buckets.setdefault(gkey, []).append(r)

    playlists = []
    for gkey, members in buckets.items():
        pids = [int(m["id"]) for m in members]
        primary_id = min(pids)
        name = members[0]["name"] or "未命名歌单"
        cover_guid = next(((m["cover_guid"] or "") for m in members if m["cover_guid"]), "")
        uids = []
        unames = []
        union_tracks = set()
        for m in members:
            uid = int(m["user_id"]) if m["user_id"] is not None else 0
            if uid and uid not in uids:
                uids.append(uid)
            uname = (m["user_name"] or "").strip()
            if uname and uname not in unames:
                unames.append(uname)
            union_tracks.update(tracks_by_pid.get(int(m["id"]), set()))

        is_reg_public = gkey[0] == "reg" and reg_public.get(gkey[1], False)
        is_all_active = bool(active_uids) and len(active_uids) > 1 and active_uids.issubset(set(uids))
        is_public = bool(is_reg_public or is_all_active or len(uids) == 0)

        safe_name = sanitize_playlist_filename(name)
        m3u_exists = False
        for cand_name in [safe_name, f"{safe_name} ({unames[0]})" if len(unames) == 1 else safe_name]:
            if os.path.exists(os.path.join(PLAYLIST_DIR, f"{cand_name}.m3u8")) or os.path.exists(
                os.path.join(PLAYLIST_DIR, f"{cand_name}.m3u")
            ):
                m3u_exists = True
                break

        playlists.append({
            "id": primary_id,
            "name": name,
            "cover_guid": cover_guid,
            "track_count": len(union_tracks),
            "users": ", ".join(unames) if unames and not is_public else "所有成员 (公共)",
            "user_ids": uids,
            "is_public": is_public,
            "created_at": members[0]["created_at"] or "",
            "playlist_ids": pids,
            "m3u_exists": m3u_exists,
        })

    playlists.sort(key=lambda item: item["id"], reverse=True)
    return playlists


def _resolve_target_playlist_group(cursor, playlist_id=None, playlist_ids=None, name: str = ""):
    groups = _build_logical_playlists(cursor)
    if playlist_ids:
        wanted = {int(x) for x in playlist_ids if str(x).isdigit() or isinstance(x, int)}
        for g in groups:
            if wanted.intersection(set(g["playlist_ids"])):
                return g
    if playlist_id is not None and str(playlist_id).strip() != "":
        target_pid = int(playlist_id)
        for g in groups:
            if target_pid == g["id"] or target_pid in g["playlist_ids"]:
                return g
    if name:
        for g in groups:
            if g["name"] == name:
                return g
    return None


def list_playlists(viewer_user_id=None, is_admin: bool = True):
    conn = get_db()
    c = conn.cursor()
    try:
        groups = _build_logical_playlists(c)
        result = []
        uid = int(viewer_user_id) if viewer_user_id is not None and str(viewer_user_id).isdigit() else None
        for g in groups:
            if not is_admin:
                if uid is None:
                    continue
                if not g["is_public"] and uid not in g["user_ids"]:
                    continue
            can_manage = bool(
                is_admin
                or (
                    uid is not None
                    and not g["is_public"]
                    and len(g["user_ids"]) == 1
                    and g["user_ids"][0] == uid
                )
            )
            result.append({**g, "can_manage": can_manage})
        return result
    finally:
        conn.close()


def _find_existing_m3u_for_group(group: dict) -> str:
    if not group:
        return ""
    safe_name = sanitize_playlist_filename(group["name"])
    candidates = []
    users_label = str(group.get("users") or "").split(",")[0].strip()
    if not group.get("is_public") and len(group.get("user_ids") or []) == 1 and users_label:
        candidates.append(f"{safe_name} ({sanitize_playlist_filename(users_label)})")
    candidates.append(safe_name)

    for base in candidates:
        for ext in (".m3u8", ".m3u"):
            try:
                p = resolve_safe_m3u_path(base, ext)
                if os.path.exists(p):
                    return p
            except Exception:
                continue
    return ""


def sync_playlist_m3u(name: str = "", playlist_id=None):
    conn = get_db(required=False)
    group = None
    if conn:
        try:
            group = _resolve_target_playlist_group(conn.cursor(), playlist_id=playlist_id, name=name)
        finally:
            conn.close()

    m3u_file = _find_existing_m3u_for_group(group) if group else ""
    if not m3u_file and name:
        for ext in (".m3u8", ".m3u"):
            try:
                cand = resolve_safe_m3u_path(name, ext)
                if os.path.exists(cand):
                    m3u_file = cand
                    break
            except Exception:
                continue
    if not m3u_file:
        return

    display_name = group["name"] if group else name
    tracks = get_playlist_tracks(name=display_name, playlist_id=group["id"] if group else playlist_id)
    lines = ["#EXTM3U", f"#PLAYLIST:{display_name}", ""]
    for t in tracks:
        p = t.get("path")
        if p and os.path.exists(p):
            dur_sec = int((t.get("duration_ms") or 0) // 1000) if t.get("duration_ms") else -1
            lines.append(f"#EXTINF:{dur_sec},{t.get('artist', '未知歌手')} - {t.get('title', '')}")
            try:
                rel_p = os.path.relpath(p, PLAYLIST_DIR)
            except ValueError:
                rel_p = p
            lines.append(rel_p)
    try:
        with open(m3u_file, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception:
        pass


def get_playlist_tracks(name: str = "", playlist_id=None, playlist_ids=None):
    conn = get_db()
    c = conn.cursor()
    try:
        group = _resolve_target_playlist_group(c, playlist_id=playlist_id, playlist_ids=playlist_ids, name=name)
        if not group:
            return []
        pids = group["playlist_ids"]
        placeholders = ",".join("?" for _ in pids)
        query = f"""
        SELECT t.id,
               t.title,
               GROUP_CONCAT(DISTINCT a.name) AS artist_names,
               al.name AS album,
               af.path,
               t.duration_ms,
               af.size,
               af.codec,
               COALESCE(NULLIF(t.cover_guid, ''), NULLIF(al.cover_guid, ''), NULLIF(MAX(a.cover_guid), ''), '') AS cover_guid,
               t.created_at AS track_created_at,
               MIN(pt.created_at) AS added_at,
               MIN(pt.id) AS first_link_id
        FROM playlist_track pt
        JOIN track t ON pt.track_id = t.id
        LEFT JOIN track_artist ta ON t.id = ta.track_id
        LEFT JOIN artist a ON ta.artist_id = a.id
        LEFT JOIN album al ON t.album_id = al.id
        LEFT JOIN audio_file af ON t.audio_file_id = af.id
        WHERE pt.playlist_id IN ({placeholders})
          AND t.is_audio_file_deleted = 0
          AND t.is_admin_deleted = 0
        GROUP BY t.id
        ORDER BY first_link_id ASC
        """
        c.execute(query, pids)
        rows = c.fetchall()
        tracks = []
        for r in rows:
            raw_artists = (r["artist_names"] or "").strip()
            artist_display = " / ".join([x for x in raw_artists.split(",") if x]) if raw_artists else "未知歌手"
            tracks.append({
                "id": r["id"],
                "title": r["title"],
                "artist": artist_display,
                "album": r["album"] or "",
                "path": r["path"] or "",
                "duration_ms": r["duration_ms"] or 0,
                "size": r["size"] or 0,
                "codec": r["codec"] or "FLAC",
                "cover_guid": r["cover_guid"] or "",
                "created_at": r["track_created_at"] or "",
                "added_at": r["added_at"] or "",
            })
        return tracks
    finally:
        conn.close()


def remove_playlist_tracks(name: str = "", track_ids: list = None, remove_physical: bool = False, playlist_id=None, playlist_ids=None):
    if not track_ids:
        return True, "未指定需移除的曲目"
    clean_tids = [int(tid) for tid in track_ids if str(tid).isdigit() or isinstance(tid, int)]
    if not clean_tids:
        return True, "未指定有效曲目 ID"

    conn = get_db()
    c = conn.cursor()
    track_paths = []
    allowed_roots = []
    target_name = name
    resolved_id = playlist_id
    try:
        group = _resolve_target_playlist_group(c, playlist_id=playlist_id, playlist_ids=playlist_ids, name=name)
        if not group:
            return False, "歌单不存在"
        p_ids = group["playlist_ids"]
        target_name = group["name"]
        resolved_id = group["id"]
        allowed_roots = get_allowed_audio_roots(c)

        placeholders_p = ",".join(["?"] * len(p_ids))
        placeholders_t = ",".join(["?"] * len(clean_tids))

        c.execute(
            f"""
            DELETE FROM playlist_track
            WHERE playlist_id IN ({placeholders_p}) AND track_id IN ({placeholders_t})
            """,
            p_ids + clean_tids,
        )

        if remove_physical:
            unreferenced_tids = get_unreferenced_track_ids(c, clean_tids)
            if unreferenced_tids:
                track_paths = get_physically_deletable_paths(c, unreferenced_tids)
                safe_mark_tracks_deleted(c, unreferenced_tids)

        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, str(e)
    finally:
        conn.close()

    sync_playlist_m3u(name=target_name, playlist_id=resolved_id)

    if remove_physical and track_paths:
        for p in track_paths:
            _remove_audio_and_sidecars(p, allowed_roots)

    return True, f"已成功从歌单【{target_name}】移出 {len(clean_tids)} 首曲目"


def update_playlist_users(name: str = "", user_ids: list = None, playlist_id=None, playlist_ids=None, is_public: bool = None):
    target_uids = {int(u) for u in (user_ids or []) if str(u).isdigit() or isinstance(u, int)}
    if not target_uids:
        return False, "至少需要指定一位可见成员"

    conn = get_db()
    c = conn.cursor()
    try:
        group = _resolve_target_playlist_group(c, playlist_id=playlist_id, playlist_ids=playlist_ids, name=name)
        if not group:
            return False, "歌单不存在"

        p_ids = group["playlist_ids"]
        target_name = group["name"]
        cover_guid = group["cover_guid"] or ""
        placeholders = ",".join("?" for _ in p_ids)

        c.execute(
            f"""
            SELECT DISTINCT pt.track_id
            FROM playlist_track pt
            WHERE pt.playlist_id IN ({placeholders})
            ORDER BY pt.id ASC
            """,
            p_ids,
        )
        track_ids = [r[0] for r in c.fetchall()]

        c.execute(f"SELECT id, user_id FROM playlist WHERE id IN ({placeholders})", p_ids)
        existing_uids = {int(r["user_id"]): int(r["id"]) for r in c.fetchall()}

        c.execute("SELECT id FROM user WHERE status = 'active'")
        all_active_uids = {int(r[0]) for r in c.fetchall()}

        final_pids = []
        now = now_cn_str()

        for uid, pid in list(existing_uids.items()):
            if uid not in target_uids:
                c.execute("DELETE FROM playlist_track WHERE playlist_id = ?", (pid,))
                c.execute("DELETE FROM playlist WHERE id = ?", (pid,))
            else:
                final_pids.append(pid)

        for uid in sorted(target_uids):
            if uid not in existing_uids:
                new_pid = safe_insert(
                    c,
                    "playlist",
                    {
                        "guid": uuid.uuid4().hex,
                        "name": target_name,
                        "cover_guid": cover_guid,
                        "user_id": uid,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                final_pids.append(int(new_pid))
                for tid in track_ids:
                    safe_insert(
                        c,
                        "playlist_track",
                        {
                            "user_id": uid,
                            "playlist_id": new_pid,
                            "track_id": tid,
                            "added_at": now,
                            "created_at": now,
                            "updated_at": now,
                        },
                        or_ignore=True,
                    )

        conn.commit()
        effective_public = bool(is_public) if is_public is not None else (bool(all_active_uids) and all_active_uids.issubset(target_uids))
        register_playlist_group(final_pids, is_public=effective_public)
        return True, f"成功更新歌单【{target_name}】的可见成员"
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, str(e)
    finally:
        conn.close()


def rename_playlist(old_name: str = "", new_name: str = "", playlist_id=None, playlist_ids=None):
    clean_new = (new_name or "").strip()
    if not clean_new:
        return False, "新歌单名称不能为空"
    if "/" in clean_new or "\\" in clean_new or ".." in clean_new:
        return False, "歌单名称不能包含路径分隔符或 .."

    conn = get_db()
    c = conn.cursor()
    old_m3u = ""
    actual_old_name = old_name
    other_same_old_name = False
    try:
        group = _resolve_target_playlist_group(c, playlist_id=playlist_id, playlist_ids=playlist_ids, name=old_name)
        if not group:
            return False, "歌单不存在"
        p_ids = group["playlist_ids"]
        actual_old_name = group["name"]
        old_m3u = _find_existing_m3u_for_group(group)

        placeholders = ",".join("?" for _ in p_ids)
        c.execute(f"SELECT COUNT(*) FROM playlist WHERE name = ? AND id NOT IN ({placeholders})", [actual_old_name] + p_ids)
        other_same_old_name = (c.fetchone()[0] or 0) > 0

        safe_update(
            c,
            "playlist",
            {"name": clean_new, "updated_at": now_cn_str()},
            f"id IN ({placeholders})",
            p_ids,
        )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, str(e)
    finally:
        conn.close()

    if old_m3u and os.path.exists(old_m3u) and not other_same_old_name:
        ext = os.path.splitext(old_m3u)[1] or ".m3u8"
        try:
            new_file = resolve_safe_m3u_path(clean_new, ext)
            if not os.path.exists(new_file):
                os.rename(old_m3u, new_file)
                sync_playlist_m3u(name=clean_new, playlist_id=playlist_id)
        except Exception:
            pass

    return True, f"成功将歌单【{actual_old_name}】重命名为【{clean_new}】"


def delete_playlist(name: str = "", delete_tracks: bool = False, playlist_id=None, playlist_ids=None):
    conn = get_db()
    c = conn.cursor()
    p_ids = []
    target_name = name
    old_m3u = ""
    other_same_name_exists = False
    track_paths = []
    allowed_roots = []

    try:
        allowed_roots = get_allowed_audio_roots(c)
        group = _resolve_target_playlist_group(c, playlist_id=playlist_id, playlist_ids=playlist_ids, name=name)
        if group:
            p_ids = group["playlist_ids"]
            target_name = group["name"]
            old_m3u = _find_existing_m3u_for_group(group)

        if not old_m3u and target_name:
            for ext in (".m3u8", ".m3u"):
                try:
                    cand = resolve_safe_m3u_path(target_name, ext)
                    if os.path.exists(cand):
                        old_m3u = cand
                        break
                except Exception:
                    continue

        if not p_ids and not old_m3u:
            return False, "歌单不存在", 0

        candidate_track_ids = []
        if delete_tracks and p_ids:
            placeholders = ",".join("?" for _ in p_ids)
            c.execute(
                f"""
                SELECT DISTINCT pt.track_id
                FROM playlist_track pt
                WHERE pt.playlist_id IN ({placeholders})
                """,
                p_ids,
            )
            candidate_track_ids = [int(r[0]) for r in c.fetchall()]

        if p_ids:
            placeholders = ",".join("?" for _ in p_ids)
            c.execute(f"SELECT COUNT(*) FROM playlist WHERE name = ? AND id NOT IN ({placeholders})", [target_name] + p_ids)
            other_same_name_exists = (c.fetchone()[0] or 0) > 0

            c.execute(f"DELETE FROM playlist_track WHERE playlist_id IN ({placeholders})", p_ids)
            c.execute(f"DELETE FROM playlist WHERE id IN ({placeholders})", p_ids)

        # 仅软删除和物理清理不再被任何其他歌单引用的曲目
        if delete_tracks and candidate_track_ids:
            unreferenced_tids = get_unreferenced_track_ids(c, candidate_track_ids)
            if unreferenced_tids:
                track_paths = get_physically_deletable_paths(c, unreferenced_tids)
                safe_mark_tracks_deleted(c, unreferenced_tids)

        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, str(e), 0
    finally:
        conn.close()

    if p_ids:
        register_playlist_group([], is_public=False)
        try:
            groups = _load_playlist_group_registry()
            pid_set = set(p_ids)
            cleaned = [g for g in groups if not pid_set.intersection(set(g.get("playlist_ids") or []))]
            if len(cleaned) != len(groups):
                with open(PLAYLIST_GROUPS_FILE, "w", encoding="utf-8") as f:
                    json.dump(cleaned, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    if old_m3u and os.path.exists(old_m3u) and not other_same_name_exists:
        try:
            os.remove(old_m3u)
        except Exception:
            pass

    deleted_files_count = 0
    if delete_tracks and track_paths:
        for p in dict.fromkeys(track_paths):
            if _remove_audio_and_sidecars(p, allowed_roots):
                deleted_files_count += 1

    msg = f"已成功删除歌单【{target_name}】"
    if delete_tracks:
        msg += f"，并安全清理了 {deleted_files_count} 首无其他歌单引用的本地歌曲"
    return True, msg, deleted_files_count


def delete_single_track(track_id, remove_physical=True):
    conn = get_db()
    c = conn.cursor()
    file_path = None
    title = ""
    allowed_roots = []
    try:
        allowed_roots = get_allowed_audio_roots(c)
        c.execute(
            """
            SELECT t.id, t.title, af.path
            FROM track t
            LEFT JOIN audio_file af ON t.audio_file_id = af.id
            WHERE t.id = ?
            """,
            (track_id,),
        )
        row = c.fetchone()
        if not row:
            return False, "曲目不存在"

        title = row["title"]
        deletable_paths = get_physically_deletable_paths(c, [track_id]) if remove_physical else []
        file_path = deletable_paths[0] if deletable_paths else None

        c.execute("DELETE FROM playlist_track WHERE track_id = ?", (track_id,))
        safe_mark_tracks_deleted(c, [track_id])
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, str(e)
    finally:
        conn.close()

    if remove_physical and file_path and os.path.exists(file_path):
        if not _remove_audio_and_sidecars(file_path, allowed_roots):
            return True, f"已在曲库标记删除，但物理文件未在受控目录内或删除失败"

    return True, f"已彻底删除曲目【{title}】"


def search_tracks(keyword="", page=1, limit=50):
    conn = get_db()
    c = conn.cursor()
    page = max(1, int(page or 1))
    limit = max(1, min(500, int(limit or 50)))
    offset = (page - 1) * limit

    filter_sql = ""
    filter_params = []
    if keyword and keyword.strip():
        kw = f"%{keyword.strip()}%"
        filter_sql = " AND (t.title LIKE ? OR a.name LIKE ? OR al.name LIKE ?)"
        filter_params = [kw, kw, kw]

    count_query = f"""
    SELECT COUNT(DISTINCT t.id)
    FROM track t
    LEFT JOIN track_artist ta ON t.id = ta.track_id
    LEFT JOIN artist a ON ta.artist_id = a.id
    LEFT JOIN album al ON t.album_id = al.id
    WHERE t.is_admin_deleted = 0 AND t.is_audio_file_deleted = 0
    {filter_sql}
    """

    page_ids_query = f"""
    SELECT t.id
    FROM track t
    LEFT JOIN track_artist ta ON t.id = ta.track_id
    LEFT JOIN artist a ON ta.artist_id = a.id
    LEFT JOIN album al ON t.album_id = al.id
    WHERE t.is_admin_deleted = 0 AND t.is_audio_file_deleted = 0
    {filter_sql}
    GROUP BY t.id
    ORDER BY t.id DESC
    LIMIT ? OFFSET ?
    """

    try:
        c.execute(count_query, filter_params)
        total = c.fetchone()[0] or 0

        c.execute(page_ids_query, filter_params + [limit, offset])
        page_ids = [int(r[0]) for r in c.fetchall()]
        if not page_ids:
            return {"total": total, "page": page, "limit": limit, "list": []}

        placeholders = ",".join("?" for _ in page_ids)
        detail_query = f"""
        SELECT t.id,
               t.title,
               GROUP_CONCAT(DISTINCT a.name) AS artist_names,
               al.name AS album,
               af.path,
               t.duration_ms,
               af.size,
               af.codec,
               COALESCE(NULLIF(t.cover_guid, ''), NULLIF(al.cover_guid, ''), NULLIF(MAX(a.cover_guid), ''), '') AS cover_guid,
               t.created_at
        FROM track t
        LEFT JOIN track_artist ta ON t.id = ta.track_id
        LEFT JOIN artist a ON ta.artist_id = a.id
        LEFT JOIN album al ON t.album_id = al.id
        LEFT JOIN audio_file af ON t.audio_file_id = af.id
        WHERE t.id IN ({placeholders})
        GROUP BY t.id
        ORDER BY t.id DESC
        """
        c.execute(detail_query, page_ids)
        rows = c.fetchall()

        tracks = []
        for r in rows:
            raw_artists = (r["artist_names"] or "").strip()
            artist_display = " / ".join([x for x in raw_artists.split(",") if x]) if raw_artists else "未知歌手"
            tracks.append({
                "id": r["id"],
                "title": r["title"],
                "artist": artist_display,
                "album": r["album"] or "",
                "path": r["path"] or "",
                "duration_ms": r["duration_ms"] or 0,
                "size": r["size"] or 0,
                "cover_guid": r["cover_guid"] or "",
                "codec": r["codec"] or "FLAC",
                "created_at": r["created_at"] or "",
            })
        return {"total": total, "page": page, "limit": limit, "list": tracks}
    finally:
        conn.close()


def find_duplicate_tracks(keyword=""):
    conn = get_db()
    c = conn.cursor()
    kw = (keyword or "").strip().lower()
    where_kw = ""
    params = []
    if kw:
        where_kw = "AND (LOWER(t.title) LIKE ? OR LOWER(COALESCE(artist_joined, '')) LIKE ? OR LOWER(COALESCE(al.name, '')) LIKE ?)"
        params = [f"%{kw}%", f"%{kw}%", f"%{kw}%"]

    query = f"""
    WITH track_agg AS (
        SELECT t.id,
               t.title,
               LOWER(TRIM(t.title)) AS norm_title,
               GROUP_CONCAT(DISTINCT a.name) AS artist_joined,
               LOWER(TRIM(COALESCE(GROUP_CONCAT(DISTINCT a.name), ''))) AS norm_artist,
               al.name AS album,
               af.path,
               t.duration_ms,
               af.size,
               af.codec,
               COALESCE(NULLIF(t.cover_guid, ''), NULLIF(al.cover_guid, ''), NULLIF(MAX(a.cover_guid), ''), '') AS cover_guid,
               t.created_at
        FROM track t
        LEFT JOIN track_artist ta ON t.id = ta.track_id
        LEFT JOIN artist a ON ta.artist_id = a.id
        LEFT JOIN album al ON t.album_id = al.id
        LEFT JOIN audio_file af ON t.audio_file_id = af.id
        WHERE t.is_admin_deleted = 0 AND t.is_audio_file_deleted = 0
        GROUP BY t.id
    ),
    dup_keys AS (
        SELECT norm_title, norm_artist, COUNT(*) AS dup_count
        FROM track_agg t
        LEFT JOIN album al ON 1=0
        WHERE 1=1 {where_kw}
        GROUP BY norm_title, norm_artist
        HAVING dup_count > 1
    )
    SELECT dk.norm_title, dk.norm_artist, dk.dup_count,
           ta.id, ta.title, ta.artist_joined AS artist, ta.album, ta.path,
           ta.duration_ms, ta.size, ta.codec, ta.cover_guid, ta.created_at
    FROM dup_keys dk
    JOIN track_agg ta ON ta.norm_title = dk.norm_title AND ta.norm_artist = dk.norm_artist
    ORDER BY dk.dup_count DESC, dk.norm_title ASC, COALESCE(ta.size, 0) DESC
    """
    try:
        c.execute(query, params)
        rows = c.fetchall()

        groups = {}
        total_duplicate_tracks = 0
        for r in rows:
            key = f"{r['norm_title']}___{r['norm_artist']}"
            artist_disp = " / ".join([x for x in (r["artist"] or "").split(",") if x]) or "未知歌手"
            if key not in groups:
                groups[key] = {
                    "key": key,
                    "title": r["title"],
                    "artist": artist_disp,
                    "count": 0,
                    "tracks": [],
                }
            if not any(x["id"] == r["id"] for x in groups[key]["tracks"]):
                groups[key]["tracks"].append({
                    "id": r["id"],
                    "title": r["title"],
                    "artist": artist_disp,
                    "album": r["album"] or "",
                    "path": r["path"] or "",
                    "duration_ms": r["duration_ms"] or 0,
                    "file_size": r["size"] or 0,
                    "size": r["size"] or 0,
                    "codec": r["codec"] or "FLAC",
                    "cover_guid": r["cover_guid"] or "",
                    "created_at": r["created_at"] or "",
                })
                groups[key]["count"] = len(groups[key]["tracks"])
                total_duplicate_tracks += 1

        valid_groups = [g for g in groups.values() if len(g["tracks"]) > 1]
        return {
            "groups_count": len(valid_groups),
            "total_tracks": total_duplicate_tracks,
            "groups": valid_groups,
        }
    finally:
        conn.close()


def batch_delete_tracks(track_ids, remove_physical=True):
    clean_ids = [int(tid) for tid in (track_ids or []) if str(tid).isdigit() or isinstance(tid, int)]
    if not clean_ids:
        return {"ok": True, "deleted_count": 0, "failed_count": 0, "message": "未指定曲目"}

    conn = get_db()
    c = conn.cursor()
    deleted_count = 0
    paths_to_delete = []
    allowed_roots = []

    try:
        allowed_roots = get_allowed_audio_roots(c)
        placeholders = ",".join("?" for _ in clean_ids)
        c.execute(
            f"""
            SELECT t.id, t.title, af.path
            FROM track t
            LEFT JOIN audio_file af ON t.audio_file_id = af.id
            WHERE t.id IN ({placeholders})
            """,
            clean_ids,
        )
        rows = c.fetchall()

        found_ids = [r["id"] for r in rows]
        if remove_physical and found_ids:
            paths_to_delete = get_physically_deletable_paths(c, found_ids)

        if found_ids:
            found_placeholders = ",".join("?" for _ in found_ids)
            c.execute(f"DELETE FROM playlist_track WHERE track_id IN ({found_placeholders})", found_ids)
            safe_mark_tracks_deleted(c, found_ids)
            conn.commit()
            deleted_count = len(found_ids)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return {"ok": False, "deleted_count": 0, "failed_count": len(clean_ids), "error": str(e)}
    finally:
        conn.close()

    if remove_physical:
        for p in paths_to_delete:
            _remove_audio_and_sidecars(p, allowed_roots)

    return {
        "ok": True,
        "deleted_count": deleted_count,
        "failed_count": len(clean_ids) - deleted_count,
        "message": f"成功删除 {deleted_count} 首曲目",
    }


VERSION_KEYWORDS = [
    "dj", "remix", "live", "现场", "伴奏", "instrumental", "karaoke", "消音",
    "acoustic", "不插电", "piano", "钢琴", "demo", "sped up", "slowed", "混音",
    "ver", "version", "remaster",
]


def _contains_version_kw(text_low: str) -> bool:
    for kw in VERSION_KEYWORDS:
        if re.match(r"^[a-z ]+$", kw):
            if re.search(rf"\b{re.escape(kw)}\b", text_low):
                return True
        elif kw in text_low:
            return True
    return False


def get_version_marker(title):
    if not title:
        return ""
    title = str(title).strip()
    parts = re.findall(r"[\(（\[【](.*?)[\)）\]】]", title)
    hyphen_parts = re.findall(r"\s*-\s*([^-\(\)（）\[\]【】]+)$", title)
    for p in parts + hyphen_parts:
        p_clean = p.strip().lower()
        if _contains_version_kw(p_clean):
            return re.sub(r"[\s\.\-_·]", "", p_clean)
    return ""


def clean_search_term(s):
    if not s:
        return ""
    cleaned = re.sub(r"[\(（\[【].*?[\)）\]】]", "", str(s)).strip()
    cleaned = re.sub(
        r"\s*-\s*(?:live|remaster|remastered|伴奏|instrumental|edit|version|ver)\b.*$",
        "",
        cleaned,
        flags=re.I,
    ).strip()
    return cleaned if cleaned else str(s).strip()


def get_artist_variants(artist_str):
    if not artist_str:
        return []
    variants = set()
    raw_artists = [
        a.strip()
        for a in re.split(r"[/,、&|]|(?:\s+feat\.?\s+)|(?:\s+with\s+)|与", str(artist_str), flags=re.I)
        if a.strip()
    ]
    if not raw_artists:
        raw_artists = [str(artist_str).strip()]

    for a in raw_artists:
        low = a.lower()
        variants.add(low)
        no_punc = re.sub(r"[\s\.\-_·'\"`]", "", low)
        if no_punc:
            variants.add(no_punc)
        cn_parts = re.findall(r"[\u4e00-\u9fa5]{2,}", a)
        for cp in cn_parts:
            variants.add(cp.lower())
        en_parts = re.findall(r"[a-zA-Z0-9]{2,}", a)
        for ep in en_parts:
            variants.add(ep.lower())
            variants.add(re.sub(r"[\s\.\-_]", "", ep).lower())
        sub_brackets = re.findall(r"[\(（](.*?)[\)）]", a)
        for sb in sub_brackets:
            if sb.strip():
                variants.add(sb.strip().lower())
        clean_base = re.sub(r"[\(（].*?[\)）]", "", a).strip().lower()
        if clean_base:
            variants.add(clean_base)

    return [v for v in variants if len(v) >= 2 or len(variants) == 1]


def _build_bulk_dedup_snapshot(c):
    """
    一次性预加载数据库曲目与磁盘音频索引，供 batch_check_songs 在内存中 O(1)/O(K) 匹配，
    彻底消除百首歌单解析时的 N+1 LIKE 全表扫描与重复 os.listdir 风暴。
    """
    by_clean_title = {}
    all_active_rows = []
    soft_deleted_paths = set()
    soft_deleted_basenames = set()

    if c is not None:
        try:
            c.execute(
                """
                SELECT t.id, t.title, a.name AS artist, af.path,
                       t.is_admin_deleted, t.is_audio_file_deleted
                FROM track t
                LEFT JOIN track_artist ta ON t.id = ta.track_id
                LEFT JOIN artist a ON ta.artist_id = a.id
                LEFT JOIN audio_file af ON t.audio_file_id = af.id
                WHERE af.path IS NOT NULL
                """
            )
            for r in c.fetchall():
                p = r["path"] or ""
                if r["is_audio_file_deleted"] != 0 or r["is_admin_deleted"] != 0:
                    if p:
                        norm_p = os.path.normpath(p)
                        soft_deleted_paths.add(norm_p)
                        soft_deleted_basenames.add(os.path.basename(norm_p).lower())
                    continue
                if not p or not os.path.exists(p):
                    continue
                rec = {
                    "id": r["id"],
                    "title": r["title"] or "",
                    "title_low": (r["title"] or "").lower(),
                    "clean_low": clean_search_term(r["title"] or "").lower(),
                    "artist_low": (r["artist"] or "").lower().strip(),
                    "artist_clean": re.sub(r"[\s\.\-_·'\"`]", "", (r["artist"] or "").lower().strip()),
                    "path": p,
                    "path_low": p.lower(),
                    "ver": get_version_marker(r["title"]) or get_version_marker(os.path.splitext(os.path.basename(p))[0]),
                }
                all_active_rows.append(rec)
                if rec["clean_low"]:
                    by_clean_title.setdefault(rec["clean_low"], []).append(rec)
                if rec["title_low"] and rec["title_low"] != rec["clean_low"]:
                    by_clean_title.setdefault(rec["title_low"], []).append(rec)
        except Exception:
            pass

    disk_files = []
    if os.path.isdir(MUSIC_ROOT):
        try:
            root_depth = MUSIC_ROOT.rstrip(os.sep).count(os.sep)
            for root, dirs, files in os.walk(MUSIC_ROOT):
                if os.path.basename(root) == "歌单":
                    dirs[:] = []
                    continue
                if root.rstrip(os.sep).count(os.sep) - root_depth >= 3:
                    dirs[:] = []
                for fname in files:
                    if fname.lower().endswith(AUDIO_EXTS):
                        full_p = os.path.normpath(os.path.join(root, fname))
                        if full_p in soft_deleted_paths or fname.lower() in soft_deleted_basenames:
                            continue
                        stem = os.path.splitext(fname)[0]
                        disk_files.append({
                            "path": full_p,
                            "path_low": full_p.lower(),
                            "fname_low": fname.lower(),
                            "ver": get_version_marker(stem),
                        })
        except Exception:
            pass

    return {
        "by_clean_title": by_clean_title,
        "all_active_rows": all_active_rows,
        "disk_files": disk_files,
    }


def _match_against_snapshot(snapshot: dict, title: str, artist: str) -> dict:
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title:
        return {"exists": False, "path": "", "id": None}

    title_low = title.lower()
    c_title = clean_search_term(title)
    c_title_low = c_title.lower()
    variants = get_artist_variants(artist)
    target_ver = get_version_marker(title)

    pool = list(snapshot["by_clean_title"].get(c_title_low, []))
    if title_low != c_title_low:
        pool.extend(snapshot["by_clean_title"].get(title_low, []))
    if not pool and c_title_low:
        pool = [
            rec for rec in snapshot["all_active_rows"]
            if rec["title_low"].startswith(c_title_low) or c_title_low in rec["path_low"]
        ]

    candidates = []
    seen_ids = set()
    for rec in pool:
        key = (rec["id"], rec["artist_low"])
        if key in seen_ids:
            continue
        seen_ids.add(key)

        if target_ver != rec["ver"]:
            continue

        artist_match = not variants
        if not artist_match:
            db_artist = rec["artist_low"]
            db_clean = rec["artist_clean"]
            db_path = rec["path_low"]
            for v in variants:
                if v == db_artist or v == db_clean:
                    artist_match = True
                    break
                if len(v) >= 2 and (v in db_artist or v in db_clean or (len(db_clean) >= 2 and db_clean in v)):
                    artist_match = True
                    break
                if len(v) >= 2 and v in db_path:
                    artist_match = True
                    break
        if not artist_match:
            continue

        score = 30
        if rec["title_low"] == title_low:
            score += 10
        elif rec["clean_low"] == c_title_low:
            score += 5
        if rec["path_low"].endswith((".flac", ".alac", ".wav")):
            score += 3
        elif rec["path_low"].endswith(".mp3"):
            score += 1
        candidates.append((score, rec))

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        best = candidates[0][1]
        return {"exists": True, "path": best["path"], "id": best["id"]}

    for df in snapshot["disk_files"]:
        if target_ver != df["ver"]:
            continue
        if title_low not in df["fname_low"] and (not c_title_low or c_title_low not in df["fname_low"]):
            continue
        if variants and not any(v in df["path_low"] for v in variants if len(v) >= 2 or len(variants) == 1):
            continue
        return {"exists": True, "path": df["path"], "id": None}

    return {"exists": False, "path": "", "id": None}


def _match_single_song_internal(c, title, artist):
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title:
        return {"exists": False, "path": "", "id": None}

    c_title = clean_search_term(title)
    variants = get_artist_variants(artist)

    candidates = []
    soft_deleted_paths = set()
    soft_deleted_inodes = set()
    if c:
        try:
            c.execute(
                """
                SELECT t.id, t.title, a.name as artist, af.path, t.is_admin_deleted, t.is_audio_file_deleted
                FROM track t
                LEFT JOIN track_artist ta ON t.id = ta.track_id
                LEFT JOIN artist a ON ta.artist_id = a.id
                LEFT JOIN audio_file af ON t.audio_file_id = af.id
                WHERE (
                    LOWER(t.title) = LOWER(?)
                    OR LOWER(t.title) = LOWER(?)
                    OR LOWER(t.title) LIKE LOWER(?)
                    OR LOWER(af.path) LIKE LOWER(?)
                )
                AND af.path IS NOT NULL
                """,
                (title, c_title, f"{c_title}%", f"%{c_title}%"),
            )

            rows = c.fetchall()
            for r in rows:
                db_artist = (r["artist"] or "").lower().strip()
                db_clean = re.sub(r"[\s\.\-_·'\"`]", "", db_artist)
                db_path = (r["path"] or "").lower()

                artist_match = not variants
                if not artist_match:
                    for v in variants:
                        if v == db_artist or v == db_clean:
                            artist_match = True
                            break
                        if len(v) >= 2 and (v in db_artist or v in db_clean or (len(db_clean) >= 2 and db_clean in v)):
                            artist_match = True
                            break
                        if len(v) >= 2 and v in db_path:
                            artist_match = True
                            break

                if not artist_match:
                    continue

                target_ver = get_version_marker(title)
                db_ver = get_version_marker(r["title"]) or get_version_marker(
                    os.path.splitext(os.path.basename(r["path"]))[0]
                )
                if target_ver != db_ver:
                    continue

                if r["is_audio_file_deleted"] != 0 or r["is_admin_deleted"] != 0:
                    if r["path"]:
                        norm_del_p = os.path.normpath(r["path"])
                        soft_deleted_paths.add(norm_del_p)
                        soft_deleted_paths.add(os.path.basename(norm_del_p).lower())
                        if os.path.exists(norm_del_p):
                            try:
                                st = os.stat(norm_del_p)
                                soft_deleted_inodes.add((st.st_dev, st.st_ino))
                            except Exception:
                                pass
                    continue

                file_exists = os.path.exists(r["path"]) if r["path"] else False
                if not file_exists:
                    continue

                score = 30
                if r["title"].lower() == title.lower():
                    score += 10
                elif clean_search_term(r["title"]).lower() == c_title.lower():
                    score += 5

                path_lower = (r["path"] or "").lower()
                if path_lower.endswith((".flac", ".alac", ".wav")):
                    score += 3
                elif path_lower.endswith(".mp3"):
                    score += 1

                candidates.append((score, r))
        except Exception:
            pass

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        best = candidates[0][1]
        return {"exists": True, "path": best["path"], "id": best["id"]}

    def _is_path_soft_deleted(p: str) -> bool:
        if not p:
            return False
        norm_p = os.path.normpath(p)
        if norm_p in soft_deleted_paths or os.path.basename(norm_p).lower() in soft_deleted_paths:
            return True
        if soft_deleted_inodes and os.path.exists(norm_p):
            try:
                st = os.stat(norm_p)
                if (st.st_dev, st.st_ino) in soft_deleted_inodes:
                    return True
            except Exception:
                pass
        return False

    if os.path.exists(MUSIC_ROOT):
        target_ver = get_version_marker(title)
        target_dirs = []
        for v in variants:
            safe_v = re.sub(r'[<>:"/\\|?*]', "_", v)
            safe_t = re.sub(r'[<>:"/\\|?*]', "_", title)
            safe_ct = re.sub(r'[<>:"/\\|?*]', "_", c_title)
            target_dirs.extend([
                os.path.join(MUSIC_ROOT, safe_v, f"{safe_v} - {safe_t}"),
                os.path.join(MUSIC_ROOT, safe_v, f"{safe_v} - {safe_ct}"),
                os.path.join(MUSIC_ROOT, safe_v, safe_t),
                os.path.join(MUSIC_ROOT, safe_v, safe_ct),
                os.path.join(MUSIC_ROOT, f"{safe_v} - {safe_t}"),
                os.path.join(MUSIC_ROOT, f"{safe_v} - {safe_ct}"),
                os.path.join(MUSIC_ROOT, safe_v),
            ])

        for d in target_dirs:
            if os.path.isdir(d):
                try:
                    for item in os.listdir(d):
                        subpath = os.path.join(d, item)
                        if os.path.isfile(subpath) and subpath.lower().endswith(AUDIO_EXTS):
                            if _is_path_soft_deleted(subpath):
                                continue
                            item_ver = get_version_marker(os.path.splitext(item)[0])
                            if target_ver != item_ver:
                                continue
                            item_low = item.lower()
                            if title.lower() in item_low or (c_title and c_title.lower() in item_low):
                                return {"exists": True, "path": subpath, "id": None}
                        elif os.path.isdir(subpath):
                            for fname in os.listdir(subpath):
                                if fname.lower().endswith(AUDIO_EXTS):
                                    full_subpath = os.path.join(subpath, fname)
                                    if _is_path_soft_deleted(full_subpath):
                                        continue
                                    fname_ver = get_version_marker(os.path.splitext(fname)[0])
                                    if target_ver != fname_ver:
                                        continue
                                    fname_low = fname.lower()
                                    if title.lower() in fname_low or (c_title and c_title.lower() in fname_low):
                                        return {"exists": True, "path": full_subpath, "id": None}
                except Exception:
                    pass

    return {"exists": False, "path": "", "id": None}


def revive_soft_deleted_track(file_path: str = "", title: str = "", artist: str = "", album: str = "") -> dict:
    """
    当曲目被重新下载入库或歌单同步时，自动将历史软删除记录置回复活状态 (0)。
    """
    conn = get_db(required=False)
    if not conn:
        return {"ok": False, "revived": False, "reason": "无法连接飞牛数据库"}
    c = conn.cursor()
    try:
        compat = check_schema_compatibility(c)
        if compat.get("safe_mode"):
            return {"ok": False, "revived": False, "reason": compat.get("reason", "safe_mode")}

        file_path = (file_path or "").strip()
        title = (title or "").strip()
        artist = (artist or "").strip()
        c_title = clean_search_term(title)
        variants = get_artist_variants(artist)
        target_ver = get_version_marker(title)

        norm_path = os.path.normpath(file_path) if file_path else ""
        base_name = os.path.basename(norm_path) if norm_path else ""
        target_inode = None
        if norm_path and os.path.exists(norm_path):
            try:
                st = os.stat(norm_path)
                target_inode = (st.st_dev, st.st_ino)
            except Exception:
                pass

        c.execute(
            """
            SELECT t.id, t.audio_file_id, af.path, t.title, a.name as artist,
                   t.is_admin_deleted, t.is_audio_file_deleted, af.is_physical_file_deleted
            FROM track t
            LEFT JOIN audio_file af ON t.audio_file_id = af.id
            LEFT JOIN track_artist ta ON t.id = ta.track_id
            LEFT JOIN artist a ON ta.artist_id = a.id
            WHERE (
                (af.path IS NOT NULL AND (af.path = ? OR af.path LIKE ?))
                OR (
                    ? != '' AND (
                        LOWER(t.title) = LOWER(?)
                        OR LOWER(t.title) = LOWER(?)
                        OR LOWER(af.path) LIKE LOWER(?)
                    )
                )
            )
            """,
            (
                norm_path or "___NONE___",
                f"%/{base_name}" if base_name else "___NONE___",
                title,
                title,
                c_title,
                f"%{c_title}%" if c_title else "___NONE___",
            ),
        )

        rows = c.fetchall()
        matched_tids = set()
        matched_afids = set()

        for r in rows:
            db_path = (r["path"] or "").strip()
            path_matched = False
            if norm_path and db_path:
                if os.path.normpath(db_path) == norm_path:
                    path_matched = True
                elif target_inode and os.path.exists(db_path):
                    try:
                        st2 = os.stat(db_path)
                        if (st2.st_dev, st2.st_ino) == target_inode:
                            path_matched = True
                    except Exception:
                        pass
                elif base_name and os.path.basename(db_path).lower() == base_name.lower():
                    path_matched = True

            meta_matched = False
            if title:
                db_ver = get_version_marker(r["title"]) or get_version_marker(
                    os.path.splitext(os.path.basename(db_path))[0]
                )
                if target_ver == db_ver:
                    db_artist = (r["artist"] or "").lower().strip()
                    db_clean = re.sub(r"[\s\.\-_·'\"`]", "", db_artist)
                    db_path_low = db_path.lower()
                    artist_ok = not variants
                    if not artist_ok:
                        for v in variants:
                            if v == db_artist or v == db_clean:
                                artist_ok = True
                                break
                            if len(v) >= 2 and (v in db_artist or v in db_clean or (len(db_clean) >= 2 and db_clean in v)):
                                artist_ok = True
                                break
                            if len(v) >= 2 and v in db_path_low:
                                artist_ok = True
                                break
                    if artist_ok and (
                        (r["title"] or "").lower() == title.lower()
                        or clean_search_term(r["title"] or "").lower() == c_title.lower()
                    ):
                        meta_matched = True

            if path_matched or meta_matched:
                if (
                    r["is_admin_deleted"] != 0
                    or r["is_audio_file_deleted"] != 0
                    or (r["is_physical_file_deleted"] or 0) != 0
                ):
                    matched_tids.add(r["id"])
                    if r["audio_file_id"]:
                        matched_afids.add(r["audio_file_id"])

        if not matched_tids:
            return {"ok": True, "revived": False, "revived_count": 0, "track_ids": []}

        now_str = now_cn_str()
        t_list = list(matched_tids)
        safe_update(
            c,
            "track",
            {
                "is_admin_deleted": 0,
                "is_audio_file_deleted": 0,
                "metadata_mode": 1,
                "metadata_cloud_provider": None,
                "metadata_cloud_ref_id": None,
                "updated_at": now_str,
            },
            f"id IN ({','.join(['?'] * len(t_list))})",
            t_list,
        )

        if matched_afids:
            af_list = list(matched_afids)
            af_update = {
                "is_physical_file_deleted": 0,
                "updated_at": now_str,
            }
            if norm_path and os.path.exists(norm_path):
                try:
                    af_update["size"] = os.path.getsize(norm_path)
                except Exception:
                    pass
            safe_update(
                c,
                "audio_file",
                af_update,
                f"id IN ({','.join(['?'] * len(af_list))})",
                af_list,
            )

        conn.commit()
        return {
            "ok": True,
            "revived": True,
            "revived_count": len(t_list),
            "track_ids": t_list,
        }
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return {"ok": False, "revived": False, "reason": str(e)}
    finally:
        conn.close()


def check_song_exists(title, artist):
    conn = get_db(required=False)
    c = conn.cursor() if conn else None
    try:
        return _match_single_song_internal(c, title, artist)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def batch_check_songs(songs):
    if not songs:
        return []
    conn = get_db(required=False)
    c = conn.cursor() if conn else None
    try:
        if len(songs) <= 3:
            return [
                _match_single_song_internal(c, (s.get("title") or "").strip(), (s.get("artist") or "").strip())
                for s in songs
            ]
        snapshot = _build_bulk_dedup_snapshot(c)
        return [
            _match_against_snapshot(snapshot, (s.get("title") or "").strip(), (s.get("artist") or "").strip())
            for s in songs
        ]
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def list_users():
    conn = get_db()
    c = conn.cursor()
    try:
        c.execute("SELECT id, guid, name, role, status FROM user ORDER BY id ASC")
        rows = c.fetchall()
        return [
            {
                "id": r["id"],
                "guid": r["guid"] or "",
                "name": r["name"],
                "role": r["role"] or "member",
                "status": r["status"] or "active",
            }
            for r in rows
        ]
    finally:
        conn.close()


def _count_audio_files_bounded(root_dir: str, max_depth: int = 3, max_files: int = 20000) -> int:
    count = 0
    if not os.path.isdir(root_dir):
        return 0
    base_depth = root_dir.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(root_dir):
        if root.rstrip(os.sep).count(os.sep) - base_depth >= max_depth:
            dirs[:] = []
        for f in files:
            if f.lower().endswith(AUDIO_EXTS):
                count += 1
                if count >= max_files:
                    return count
    return count


def _probe_dir_writable(p: str) -> bool:
    if not os.path.isdir(p):
        return False
    try:
        test_file = os.path.join(p, f".trim_test_write_{os.getpid()}")
        with open(test_file, "w", encoding="utf-8") as tf:
            tf.write("ok")
        os.remove(test_file)
        return True
    except Exception:
        return False


def list_authorized_directories():
    dirs = []
    seen = set()
    seen_inodes = set()

    def _get_inode_key(p):
        try:
            st = os.stat(p)
            return (st.st_dev, st.st_ino)
        except Exception:
            return None

    try:
        conn = get_db(required=False)
        if conn:
            try:
                c = conn.cursor()
                c.execute("SELECT id, guid, path, created_at FROM shared_library")
                for r in c.fetchall():
                    p = r["path"]
                    if not p:
                        continue
                    norm_p = os.path.normpath(p)
                    inode_key = _get_inode_key(p)
                    if norm_p in seen or (inode_key and inode_key in seen_inodes):
                        continue
                    seen.add(norm_p)
                    if inode_key:
                        seen_inodes.add(inode_key)

                    exists = os.path.exists(p)
                    writable = _probe_dir_writable(p) if exists else False
                    file_count = 0
                    if exists:
                        try:
                            c.execute(
                                "SELECT COUNT(*) FROM track WHERE shared_library_id = ? AND is_audio_file_deleted = 0 AND is_admin_deleted = 0",
                                (r["id"],),
                            )
                            row_cnt = c.fetchone()
                            file_count = row_cnt[0] if row_cnt else 0
                        except Exception:
                            file_count = 0
                        if file_count == 0:
                            file_count = _count_audio_files_bounded(p)
                    dirs.append({
                        "path": p,
                        "name": "飞牛官方授权音乐库",
                        "is_fnos_authorized": True,
                        "exists": exists,
                        "writable": writable,
                        "file_count": file_count,
                        "guid": r["guid"],
                    })
            finally:
                conn.close()
    except Exception:
        pass

    if not dirs:
        candidates = [
            "/vol1/1000/Music",
            "/vol2/1000/Music",
            "/media/music",
        ]
        for base in ["/vol1/1000", "/vol2/1000", "/vol3/1000"]:
            if os.path.isdir(base):
                for sub in ["媒体/音乐", "音乐", "Music", "media/music"]:
                    p = os.path.join(base, sub)
                    if p not in candidates:
                        candidates.append(p)

        for cand in candidates:
            norm_cand = os.path.normpath(cand)
            inode_key = _get_inode_key(cand)
            if norm_cand in seen or (inode_key and inode_key in seen_inodes):
                continue
            if os.path.exists(cand):
                seen.add(norm_cand)
                if inode_key:
                    seen_inodes.add(inode_key)
                dirs.append({
                    "path": cand,
                    "name": os.path.basename(cand) or cand,
                    "is_fnos_authorized": False,
                    "exists": True,
                    "writable": _probe_dir_writable(cand),
                    "file_count": _count_audio_files_bounded(cand),
                    "guid": "",
                })

    current_setting = load_effective_music_dir()
    if current_setting and os.path.exists(current_setting):
        norm_setting = os.path.normpath(current_setting)
        inode_key = _get_inode_key(current_setting)
        if norm_setting not in seen and (not inode_key or inode_key not in seen_inodes):
            seen.add(norm_setting)
            if inode_key:
                seen_inodes.add(inode_key)
            dirs.append({
                "path": current_setting,
                "name": os.path.basename(current_setting) or current_setting,
                "is_fnos_authorized": False,
                "exists": True,
                "writable": _probe_dir_writable(current_setting),
                "file_count": _count_audio_files_bounded(current_setting),
                "guid": "",
            })

    return dirs


def verify_directory(target_path):
    p = os.path.abspath(target_path.strip()) if target_path else ""
    if not p or p == "/":
        return {"ok": False, "error": "路径不能为空或系统根目录"}

    exists = os.path.exists(p)
    is_dir = os.path.isdir(p) if exists else False
    error = None

    if exists and not is_dir:
        return {"ok": False, "error": "指定路径是一个文件而非目录"}

    if not exists:
        try:
            os.makedirs(p, mode=0o775, exist_ok=True)
            exists = True
            try:
                puid = int(os.environ.get("PUID", "1000"))
                pgid = int(os.environ.get("PGID", "1000"))
                os.chown(p, puid, pgid)
                os.chmod(p, 0o775)
            except Exception:
                pass
        except Exception as e:
            return {"ok": False, "error": f"创建目录失败: {e}"}

    writable = _probe_dir_writable(p)
    if not writable:
        error = "目录无写入权限"

    is_fnos_authorized = False
    conn = get_db(required=False)
    if conn:
        try:
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM shared_library WHERE path = ?", (p,))
            row = c.fetchone()
            if row and row[0] > 0:
                is_fnos_authorized = True
        except Exception:
            pass
        finally:
            conn.close()

    return {
        "ok": writable,
        "path": p,
        "exists": exists,
        "writable": writable,
        "is_fnos_authorized": is_fnos_authorized,
        "error": error,
    }


def _parse_playlist_selector_arg(raw_arg: str):
    """支持传入整数 playlist_id、JSON 对象 {"playlist_id": 12, "name": "..."} 或旧版纯字符串歌单名。"""
    if not raw_arg:
        return {"playlist_id": None, "playlist_ids": None, "name": ""}
    s = str(raw_arg).strip()
    if s.startswith("{"):
        try:
            obj = json.loads(s)
            return {
                "playlist_id": obj.get("playlist_id") if obj.get("playlist_id") is not None else obj.get("id"),
                "playlist_ids": obj.get("playlist_ids"),
                "name": str(obj.get("name") or ""),
                "is_public": obj.get("is_public"),
            }
        except Exception:
            pass
    if s.isdigit():
        return {"playlist_id": int(s), "playlist_ids": None, "name": ""}
    return {"playlist_id": None, "playlist_ids": None, "name": s}


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "list_playlists"
    if action == "list_playlists":
        viewer_uid = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
        viewer_admin = (sys.argv[3].lower() == "true") if len(sys.argv) > 3 else True
        print(json.dumps(list_playlists(viewer_user_id=viewer_uid, is_admin=viewer_admin), ensure_ascii=False))
    elif action == "list_users":
        print(json.dumps(list_users(), ensure_ascii=False))
    elif action == "get_playlist_tracks":
        sel = _parse_playlist_selector_arg(sys.argv[2] if len(sys.argv) > 2 else "")
        print(
            json.dumps(
                get_playlist_tracks(
                    name=sel["name"], playlist_id=sel["playlist_id"], playlist_ids=sel["playlist_ids"]
                ),
                ensure_ascii=False,
            )
        )
    elif action == "rename_playlist":
        sel = _parse_playlist_selector_arg(sys.argv[2] if len(sys.argv) > 2 else "")
        new_name = sys.argv[3] if len(sys.argv) > 3 else ""
        ok, msg = rename_playlist(
            old_name=sel["name"],
            new_name=new_name,
            playlist_id=sel["playlist_id"],
            playlist_ids=sel["playlist_ids"],
        )
        print(json.dumps({"ok": ok, "message": msg}, ensure_ascii=False))
    elif action == "delete_playlist":
        sel = _parse_playlist_selector_arg(sys.argv[2] if len(sys.argv) > 2 else "")
        delete_tracks = sys.argv[3].lower() == "true" if len(sys.argv) > 3 else False
        ok, msg, count = delete_playlist(
            name=sel["name"],
            delete_tracks=delete_tracks,
            playlist_id=sel["playlist_id"],
            playlist_ids=sel["playlist_ids"],
        )
        print(json.dumps({"ok": ok, "message": msg, "deleted_files": count}, ensure_ascii=False))
    elif action == "check_song_exists":
        title = sys.argv[2]
        artist = sys.argv[3]
        print(json.dumps(check_song_exists(title, artist), ensure_ascii=False))
    elif action == "batch_check":
        raw_input = sys.stdin.read() if (len(sys.argv) <= 2 or sys.argv[2] == "-") else sys.argv[2]
        songs = json.loads(raw_input or "[]")
        print(json.dumps(batch_check_songs(songs), ensure_ascii=False))
    elif action == "delete_track":
        tid = int(sys.argv[2])
        remove_physical = sys.argv[3].lower() == "true" if len(sys.argv) > 3 else True
        ok, msg = delete_single_track(tid, remove_physical)
        print(json.dumps({"ok": ok, "message": msg}, ensure_ascii=False))
    elif action == "search_tracks":
        q = sys.argv[2] if len(sys.argv) > 2 else ""
        page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 50
        print(json.dumps(search_tracks(q, page, limit), ensure_ascii=False))
    elif action == "list_authorized_directories":
        print(json.dumps(list_authorized_directories(), ensure_ascii=False))
    elif action == "verify_directory":
        p = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(verify_directory(p), ensure_ascii=False))
    elif action == "find_duplicates":
        q = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(find_duplicate_tracks(q), ensure_ascii=False))
    elif action == "batch_delete_tracks":
        raw_input = sys.stdin.read() if (len(sys.argv) <= 2 or sys.argv[2] == "-") else sys.argv[2]
        track_ids = json.loads(raw_input or "[]")
        remove_physical = sys.argv[3].lower() == "true" if len(sys.argv) > 3 else True
        print(json.dumps(batch_delete_tracks(track_ids, remove_physical), ensure_ascii=False))
    elif action == "update_playlist_users":
        sel = _parse_playlist_selector_arg(sys.argv[2] if len(sys.argv) > 2 else "")
        user_ids = json.loads(sys.argv[3])
        ok, msg = update_playlist_users(
            name=sel["name"],
            user_ids=user_ids,
            playlist_id=sel["playlist_id"],
            playlist_ids=sel["playlist_ids"],
            is_public=sel.get("is_public"),
        )
        print(json.dumps({"ok": ok, "message": msg}, ensure_ascii=False))
    elif action == "remove_playlist_tracks":
        sel = _parse_playlist_selector_arg(sys.argv[2] if len(sys.argv) > 2 else "")
        raw_tids = sys.stdin.read() if (len(sys.argv) <= 3 or sys.argv[3] == "-") else sys.argv[3]
        track_ids = json.loads(raw_tids or "[]")
        remove_physical = sys.argv[4].lower() == "true" if len(sys.argv) > 4 else False
        ok, msg = remove_playlist_tracks(
            name=sel["name"],
            track_ids=track_ids,
            remove_physical=remove_physical,
            playlist_id=sel["playlist_id"],
            playlist_ids=sel["playlist_ids"],
        )
        print(json.dumps({"ok": ok, "message": msg}, ensure_ascii=False))
    elif action == "check_schema":
        print(json.dumps(check_schema_compatibility(), ensure_ascii=False))
    elif action == "revive_track":
        file_path = sys.argv[2] if len(sys.argv) > 2 else ""
        title = sys.argv[3] if len(sys.argv) > 3 else ""
        artist = sys.argv[4] if len(sys.argv) > 4 else ""
        album = sys.argv[5] if len(sys.argv) > 5 else ""
        print(json.dumps(revive_soft_deleted_track(file_path, title, artist, album), ensure_ascii=False))
